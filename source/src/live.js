// 实时音源：在电脑上抓标签页/系统声音，切成 20ms 分段，带上控制端时钟时间戳
const SR = 48000, FRAMES = 960; // 20ms

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.n = ${FRAMES}; this.reset(); this.frame = 0; }
  reset() { this.l = new Float32Array(this.n); this.r = new Float32Array(this.n); this.i = 0; }
  process(inputs) {
    const inp = inputs[0];
    const L = inp && inp[0], R = (inp && inp[1]) || L;
    const len = L ? L.length : 128;
    for (let k = 0; k < len; k++) {
      this.l[this.i] = L ? L[k] : 0; this.r[this.i] = R ? R[k] : 0;
      if (++this.i === this.n) {
        this.port.postMessage({ frame: this.frame, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);
        this.frame += this.n; this.reset();
      }
    }
    return true;
  }
}
registerProcessor('sm-cap', Cap);`;

export async function opusDecodeSupported() {
  try {
    if (typeof AudioDecoder === 'undefined') return false;
    const r = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: SR, numberOfChannels: 2 });
    return !!r.supported;
  } catch { return false; }
}

export class LiveCapture extends EventTarget {
  constructor(hostNow) {
    super();
    this.hostNow = hostNow;
    this.running = false;
    this.stats = { chunks: 0, level: 0 };
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // 弹出浏览器的“共享”窗口。Chrome/Edge：选“标签页”并勾选“共享标签页音频”，或选“整个屏幕”并勾选“共享系统音频”
  async startCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('这个浏览器不支持共享声音，请在电脑上用 Chrome 或 Edge');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true, restrictOwnAudio: true },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('没有抓到声音：共享时要勾选“共享标签页音频”或“共享系统音频”');
    }
    // 共享的是标签页时，浏览器会把那个标签页在电脑上静音（避免听到比手机早的声音）
    this.surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface || 'unknown';

    return this.startFromStream(stream);
  }

  async startFromStream(stream) {
    await this.stop();
    this.stream = stream;
    this.videoTrack = stream.getVideoTracks()[0] || null; // 画面留着给“同步画面”用
    this.ctx = new AudioContext({ sampleRate: SR });
    await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.srcNode = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'sm-cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.srcNode.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    this.anchor = null; this.ema = 0; this.stats = { chunks: 0, level: 0 };
    this.node.port.onmessage = (e) => this.onChunk(e.data);
    stream.getAudioTracks()[0].addEventListener('ended', () => this.stop());
    this.running = true;
    this.emit('state', true);
  }

  // 采集帧号 -> 控制端时钟（毫秒）。音频硬件时钟和系统时钟会慢慢漂移，偏差超过 15ms 就重新对准
  tsOf(frame) { return this.anchor.host + ((frame - this.anchor.frame) / SR) * 1000; }
  onChunk({ frame, l, r }) {
    const now = this.hostNow();
    if (!this.anchor) this.anchor = { host: now - (FRAMES / SR) * 1000, frame };
    const ts = this.tsOf(frame);
    const err = now - (ts + (FRAMES / SR) * 1000);
    this.ema = this.ema * 0.97 + err * 0.03;
    if (Math.abs(this.ema) > 15) { this.anchor.host += this.ema; this.ema = 0; }
    let peak = 0;
    for (let i = 0; i < FRAMES; i += 8) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    this.stats.level = Math.max(peak, this.stats.level * 0.9);
    this.stats.chunks++;
    this.emit('chunk', { frame, ts, l, r });
  }

  async stop() {
    if (!this.running && !this.stream) return;
    this.running = false;
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await this.ctx?.close(); } catch {}
    this.stream = null; this.ctx = null; this.videoTrack = null;
    this.emit('state', false);
  }
}

// PCM 打包：Float32 各声道 -> Int16 交错
export function pcmEncode(planes) {
  const ch = planes.length, n = planes[0].length, out = new Int16Array(n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = Math.max(-1, Math.min(1, planes[c][i])) * 32767;
  return out;
}

// 一路音频（完整混音或某个声部）的 Opus 编码器
export class StreamEncoder {
  constructor(channels, onChunk) {
    this.channels = channels; this.ok = false;
    // 每送进去 20ms 就出来一包；时间戳按送进去的顺序对应，不用编码器自己算的（它会忽略中间的停顿）
    this.q = [];
    if (typeof AudioEncoder === 'undefined') return;
    try {
      this.enc = new AudioEncoder({
        output: (chunk) => {
          const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
          const ts = this.q.length ? this.q.shift() : chunk.timestamp / 1000;
          onChunk(ts, d);
        },
        error: () => { this.ok = false; },
      });
      this.enc.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: channels, bitrate: channels === 2 ? 160000 : 96000 });
      this.ok = true;
    } catch { this.ok = false; }
  }
  encode(ts, planes) {
    if (!this.ok || this.enc.state !== 'configured') return false;
    const n = planes[0].length, data = new Float32Array(n * this.channels);
    planes.forEach((p, c) => data.set(p, c * n));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: this.channels, timestamp: Math.round(ts * 1000), data });
    this.q.push(ts);
    if (this.q.length > 50) this.q.shift(); // 防止异常时无限堆积
    this.enc.encode(ad); ad.close();
    return true;
  }
  close() { try { this.enc?.close(); } catch {} }
}

// 播放节点：把收到的分段变成 AudioBuffer
export class LiveDecoder {
  constructor(ctx, onBuffer) {
    this.ctx = ctx; this.onBuffer = onBuffer; this.decs = new Map();
  }
  pcm(ts, payload, sr, ch, src) {
    const pcm = new Int16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    const n = pcm.length / ch, buf = this.ctx.createBuffer(ch, n, sr);
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = pcm[i * ch + c] / 32768; }
    this.onBuffer(ts, buf, src);
  }
  opus(ts, payload, ch, src) {
    let dec = this.decs.get(src);
    // 中间停过（比如重新共享），解码器重建，避免把新声音接在旧时间线后面
    if (dec && dec.lastTs !== undefined && (ts - dec.lastTs > 300 || ts < dec.lastTs - 300)) { try { dec.close(); } catch {} dec = null; }
    if (!dec || dec.state === 'closed') {
      const q = [];
      dec = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames, buf = this.ctx.createBuffer(ch, n, ad.sampleRate);
          for (let c = 0; c < ch; c++) {
            const tmp = new Float32Array(n);
            ad.copyTo(tmp, { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: 'f32-planar' });
            buf.copyToChannel(tmp, c);
          }
          // 时间戳按送进去的顺序对应，不用解码器自己算的
          const t = q.length ? q.shift() : ad.timestamp / 1000;
          ad.close();
          this.onBuffer(t, buf, src);
        },
        error: () => this.decs.delete(src),
      });
      dec.q = q;
      dec.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: ch });
      this.decs.set(src, dec);
    }
    dec.lastTs = ts;
    dec.q.push(ts);
    if (dec.q.length > 50) dec.q.shift();
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts * 1000), data: payload }));
  }
}


// 同步画面：把共享的画面延后同样的缓冲时间再显示，和手机放出的声音对齐
export class VideoMirror {
  constructor(canvas, getDelayMs) {
    this.canvas = canvas; this.ctx2d = canvas.getContext('2d'); this.getDelay = getDelayMs;
    this.q = []; this.running = false;
  }
  static supported() { return typeof window.MediaStreamTrackProcessor === 'function'; }
  start(track) {
    this.stop();
    if (!track || !VideoMirror.supported()) return false;
    this.running = true;
    this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    this.pump();
    const draw = () => { if (!this.running) return; this.draw(); requestAnimationFrame(draw); };
    requestAnimationFrame(draw);
    return true;
  }
  async pump() {
    const reader = this.reader;
    while (this.running && reader === this.reader) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      const frame = r.value, t = performance.now();
      try {
        // 缩小后转成图片保存，原始画面帧马上释放（采集端的帧数量有限，扣着不放会卡住）
        const w = Math.min(1280, frame.displayWidth), h = Math.round((frame.displayHeight * w) / frame.displayWidth);
        const bmp = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
        this.q.push({ t, bmp });
      } catch {}
      frame.close();
      while (this.q.length > 150) this.q.shift().bmp.close(); // 最多存约 5 秒
    }
  }
  draw() {
    const due = performance.now() - this.getDelay();
    let pick = null;
    while (this.q.length && this.q[0].t <= due) { if (pick) pick.bmp.close(); pick = this.q.shift(); }
    if (!pick) return;
    const { bmp } = pick, c = this.canvas;
    if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
    this.ctx2d.drawImage(bmp, 0, 0);
    this.last?.bmp.close();
    this.last = pick;
  }
  stop() {
    this.running = false;
    try { this.reader?.cancel(); } catch {}
    this.reader = null;
    for (const x of this.q) x.bmp.close();
    this.q = [];
  }
}
