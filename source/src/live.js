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
    stream.getVideoTracks().forEach((t) => (t.enabled = false)); // 画面不需要
    return this.startFromStream(stream);
  }

  async startFromStream(stream) {
    await this.stop();
    this.stream = stream;
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
    this.setupEncoder();
    this.running = true;
    this.emit('state', true);
  }

  setupEncoder() {
    this.encoder = null;
    if (typeof AudioEncoder === 'undefined') return;
    try {
      this.encoder = new AudioEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          this.emit('opus', { ts: chunk.timestamp / 1000, data });
        },
        error: () => { this.encoder = null; },
      });
      this.encoder.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 2, bitrate: 160000 });
    } catch { this.encoder = null; }
  }

  // 采集帧号 -> 控制端时钟（毫秒）。音频硬件时钟和系统时钟会慢慢漂移，偏差超过 15ms 就重新对准
  onChunk({ frame, l, r }) {
    const now = this.hostNow();
    if (!this.anchor) this.anchor = { host: now - (FRAMES / SR) * 1000, frame };
    const ts = this.anchor.host + ((frame - this.anchor.frame) / SR) * 1000;
    const err = now - (ts + (FRAMES / SR) * 1000);
    this.ema = this.ema * 0.97 + err * 0.03;
    if (Math.abs(this.ema) > 15) { this.anchor.host += this.ema; this.ema = 0; }
    let peak = 0;
    for (let i = 0; i < FRAMES; i += 8) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    this.stats.level = Math.max(peak, this.stats.level * 0.9);
    this.stats.chunks++;
    this.emit('chunk', { ts, l, r }); // 原始 PCM（给不支持 Opus 的设备、以及控制端本机）
    if (this.encoder && this.wantOpus && this.encoder.state === 'configured') {
      const planar = new Float32Array(FRAMES * 2);
      planar.set(l, 0); planar.set(r, FRAMES);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: FRAMES, numberOfChannels: 2, timestamp: Math.round(ts * 1000), data: planar });
      this.encoder.encode(ad);
      ad.close();
    }
  }

  async stop() {
    if (!this.running && !this.stream) return;
    this.running = false;
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.encoder?.close(); } catch {}
    try { await this.ctx?.close(); } catch {}
    this.stream = null; this.ctx = null; this.encoder = null;
    this.emit('state', false);
  }
}

// PCM 打包：Float32 两声道 -> Int16 交错
export function pcmEncode(l, r) {
  const out = new Int16Array(l.length * 2);
  for (let i = 0; i < l.length; i++) {
    out[2 * i] = Math.max(-1, Math.min(1, l[i])) * 32767;
    out[2 * i + 1] = Math.max(-1, Math.min(1, r[i])) * 32767;
  }
  return out;
}

// 播放节点：把收到的分段变成 AudioBuffer
export class LiveDecoder {
  constructor(ctx, onBuffer) {
    this.ctx = ctx; this.onBuffer = onBuffer; this.dec = null;
  }
  pcm(ts, payload, sr) {
    const pcm = new Int16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    const n = pcm.length / 2;
    const buf = this.ctx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) { L[i] = pcm[2 * i] / 32768; R[i] = pcm[2 * i + 1] / 32768; }
    this.onBuffer(ts, buf);
  }
  opus(ts, payload) {
    if (!this.dec || this.dec.state === 'closed') {
      this.dec = new AudioDecoder({
        output: (ad) => {
          const n = ad.numberOfFrames, ch = Math.min(2, ad.numberOfChannels);
          const buf = this.ctx.createBuffer(2, n, ad.sampleRate);
          for (let c = 0; c < 2; c++) {
            const tmp = new Float32Array(n);
            ad.copyTo(tmp, { planeIndex: Math.min(c, ch - 1), format: 'f32-planar' });
            buf.copyToChannel(tmp, c);
          }
          const t = ad.timestamp / 1000;
          ad.close();
          this.onBuffer(t, buf);
        },
        error: () => { this.dec = null; },
      });
      this.dec.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: 2 });
    }
    this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(ts * 1000), data: payload }));
  }
}
