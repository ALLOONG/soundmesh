// 麦克风自动校准：每台设备在指定时刻播放一段扫频“啾”声，听众位的麦克风录下来，
// 用互相关找出每台设备实际出声的时间，算出各自的固定延迟差。

const CHIRP_SEC = 0.04;

export function makeChirp(sr) {
  const n = Math.round(sr * CHIRP_SEC), out = new Float32Array(n);
  const f0 = 1500, f1 = 6000, T = CHIRP_SEC;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann 窗
    out[i] = Math.sin(2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T))) * w;
  }
  return out;
}

const REC_WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor() { super(); this.frame = 0; this.buf = new Float32Array(2048); this.i = 0; this.start = -1; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    for (let k = 0; k < len; k++) {
      if (this.start < 0) this.start = this.frame;
      this.buf[this.i++] = ch ? ch[k] : 0;
      this.frame++;
      if (this.i === this.buf.length) {
        this.port.postMessage({ end: this.frame, data: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(2048); this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('sm-rec', Rec);`;

export class MicRecorder {
  constructor(ctx, clockNow) { this.ctx = ctx; this.clockNow = clockNow; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.ctx.__smRec) {
      const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.ctx.__smRec = true;
    }
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'sm-rec', { channelCount: 1, channelCountMode: 'explicit' });
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    this.chunks = []; this.startHost = null; this.firstEnd = null;
    this.node.port.onmessage = (e) => {
      const { end, data } = e.data;
      // 用第一段建立“录音样本号 -> 控制端时钟”的对应关系（输入端固定延迟对所有设备相同，会在比较中抵消）
      if (this.startHost === null) { this.startHost = this.clockNow() - (end / this.ctx.sampleRate) * 1000; }
      this.chunks.push(data);
    };
  }
  stop() {
    try { this.src.disconnect(); this.node.disconnect(); } catch {}
    this.stream.getTracks().forEach((t) => t.stop());
    const n = this.chunks.reduce((a, c) => a + c.length, 0), rec = new Float32Array(n);
    let o = 0; for (const c of this.chunks) { rec.set(c, o); o += c.length; }
    return { rec, sr: this.ctx.sampleRate, startHost: this.startHost };
  }
}

// slots: [{ did, at }]，at = 该设备“应该”在听众位被听到的控制端时间
// 返回每个 slot 的误差（毫秒，正数 = 实际比应有的晚）
export function detectChirps({ rec, sr, startHost }, slots) {
  const tpl = makeChirp(sr), m = tpl.length;
  let tplE = 0; for (let i = 0; i < m; i++) tplE += tpl[i] * tpl[i];
  return slots.map((s) => {
    const center = Math.round(((s.at - startHost) / 1000) * sr);
    const a = Math.max(0, center - Math.round(0.3 * sr)), b = Math.min(rec.length - m, center + Math.round(0.5 * sr));
    if (b <= a) return { ...s, ok: false };
    let best = -Infinity, bestI = -1;
    const vals = new Float32Array(b - a);
    for (let i = a; i < b; i++) {
      let acc = 0;
      for (let j = 0; j < m; j++) acc += rec[i + j] * tpl[j];
      const v = Math.abs(acc);
      vals[i - a] = v;
      if (v > best) { best = v; bestI = i; }
    }
    const sorted = Array.from(vals).sort((x, y) => x - y);
    const noise = sorted[Math.floor(sorted.length * 0.5)] || 1e-9;
    const ratio = best / noise;
    const err = startHost + (bestI / sr) * 1000 - s.at;
    return { ...s, err, ratio, ok: ratio > 8 };
  });
}

export const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
