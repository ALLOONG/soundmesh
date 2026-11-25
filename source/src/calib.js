import { FFT } from './separator.js';
// 麦克风自动校准：每台设备在指定时刻播放一段扫频“啾”声，听众位的麦克风录下来，
// 用互相关找出每台设备实际出声的时间，算出各自的固定延迟差。

const CHIRP_SEC = 0.05;

// 宽频“啾”：1kHz → 12kHz。频带越宽，峰越尖，定位越准（手机小喇叭也放得出来）
export function makeChirp(sr) {
  const n = Math.round(sr * CHIRP_SEC), out = new Float32Array(n);
  const f0 = 1000, f1 = Math.min(12000, sr * 0.45), T = CHIRP_SEC;
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
    // 麦克风本身的输入延迟（录到的声音比实际晚这么多），之后从测量结果里扣掉，才能算出声音真正到达的时刻
    const st = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
    this.inLat = Number.isFinite(st.latency) && st.latency > 0 && st.latency < 0.3 ? st.latency : (this.ctx.baseLatency || 0.01);
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
    const res = { rec, sr: this.ctx.sampleRate, startHost: this.startHost, inLat: this.inLat || 0 };
    return typeof window !== 'undefined' && window.__smFakeMic ? window.__smFakeMic(res) : res; // 自动测试用（平时不存在）
  }
}

// slots: [{ did, at }]，at = 该设备“应该”在听众位被听到的控制端时间
// 返回每个 slot 的误差（毫秒，正数 = 实际比应有的晚）
// 做法：用 FFT 算互相关，再取“包络”（不会因为波形一正一负而跳半个周期），
// 找最早到达的那个峰（不是墙壁反射回来的），再用抛物线插值精确到不到 1 个采样点（约 0.02ms）
export function detectChirps({ rec, sr, startHost, inLat = 0 }, slots) {
  const tpl = makeChirp(sr), m = tpl.length;
  const before = Math.round(0.3 * sr), after = Math.round(0.6 * sr); // 往后多听一点：蓝牙音箱可能晚 0.5 秒
  let N = 1; while (N < before + after + m * 2) N <<= 1;
  const fft = new FFT(N);
  const tr = new Float64Array(N), ti = new Float64Array(N);
  for (let i = 0; i < m; i++) tr[i] = tpl[i];
  fft.run(tr, ti, false);
  return slots.map((s) => {
    const center = Math.round(((s.at - startHost) / 1000) * sr);
    const a = center - before, len = before + after + m;
    if (a < 0 || a + len > rec.length) return { ...s, ok: false };
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < len; i++) re[i] = rec[a + i];
    fft.run(re, im, false);
    // Y × conj(X)，只保留正频率（×2）→ 反变换后取模 = 互相关的包络
    for (let k = 0; k < N; k++) {
      if (k > N / 2) { re[k] = 0; im[k] = 0; continue; }
      const xr = tr[k], xi = -ti[k], yr = re[k], yi = im[k], w = k === 0 || k === N / 2 ? 1 : 2;
      re[k] = (yr * xr - yi * xi) * w; im[k] = (yr * xi + yi * xr) * w;
    }
    fft.run(re, im, true);
    const L = before + after, env = new Float64Array(L);
    let best = 0, bi = 0;
    for (let i = 0; i < L; i++) { env[i] = Math.hypot(re[i], im[i]); if (env[i] > best) { best = env[i]; bi = i; } }
    // 最早到达：最高峰之前 4ms 内，如果有一个超过最高峰 60% 的峰，那才是直达声（后面的是反射）
    let pk = bi;
    for (let i = Math.max(1, bi - Math.round(0.004 * sr)); i < bi; i++) {
      if (env[i] >= best * 0.6 && env[i] >= env[i - 1] && env[i] >= env[i + 1]) { pk = i; break; }
    }
    const y0 = env[pk - 1] || 0, y1 = env[pk], y2 = env[pk + 1] || 0, den = y0 - 2 * y1 + y2;
    const frac = den ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    const sorted = Array.from(env).sort((x, y) => x - y);
    const noise = sorted[Math.floor(sorted.length * 0.5)] || 1e-12;
    const ratio = y1 / noise;
    const err = startHost + ((a + pk + frac) / sr) * 1000 - inLat * 1000 - s.at;
    return { ...s, err, ratio, ok: ratio > 8 };
  });
}

// 稳健的“代表值”：先取中位数，再把离中位数 0.5ms 以内的结果取平均（去掉偶尔的误判）
export function robustMean(arr) {
  const med = median(arr);
  if (med === null) return null;
  const near = arr.filter((v) => Math.abs(v - med) <= 0.5);
  return near.length ? near.reduce((a, b) => a + b, 0) / near.length : med;
}

export const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

// ---------- 分工检查：分析每台设备单独出声时的频谱 ----------
// windows: [{ did, from, to }]（控制端时间），noiseWin: { from, to }（所有设备静音时的底噪）
export function analyzeWindows({ rec, sr, startHost }, windows, noiseWin) {
  const N = 2048, fft = new FFT(N), hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = sr / N;
  const toIdx = (t) => Math.round(((t - startHost) / 1000) * sr);
  const feats = (from, to) => {
    const a = Math.max(0, toIdx(from)), b = Math.min(rec.length, toIdx(to));
    let low = 0, mid = 0, high = 0; const fe = [];
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let s = a; s + N <= b; s += N / 2) {
      for (let i = 0; i < N; i++) { re[i] = rec[s + i] * hann[i]; im[i] = 0; }
      fft.run(re, im, false);
      let e = 0;
      for (let k = 1; k < N / 2; k++) {
        const f = k * binHz, p = re[k] * re[k] + im[k] * im[k];
        if (f < 200) low += p; else if (f < 2500) mid += p; else if (f < 10000) high += p;
        if (f < 10000) e += p;
      }
      fe.push(e);
    }
    const mean = fe.reduce((x, y) => x + y, 0) / (fe.length || 1);
    const sd = Math.sqrt(fe.reduce((x, y) => x + (y - mean) ** 2, 0) / (fe.length || 1));
    return { low, mid, high, total: low + mid + high, cv: mean ? sd / mean : 0 };
  };
  const noise = feats(noiseWin.from, noiseWin.to);
  return windows.map((w) => {
    const f = feats(w.from + 400, w.to - 150); // 去掉开头淡入和结尾
    // 减去底噪再算占比
    const clean = { low: Math.max(0, f.low - noise.low), mid: Math.max(0, f.mid - noise.mid), high: Math.max(0, f.high - noise.high) };
    const tot = clean.low + clean.mid + clean.high;
    const snr = 10 * Math.log10((f.total + 1e-12) / (noise.total + 1e-12));
    const share = tot > 0 ? { low: clean.low / tot, mid: clean.mid / tot, high: clean.high / tot } : { low: 0, mid: 0, high: 0 };
    let label;
    if (snr < 4) label = '几乎听不到';
    else if (f.cv > 0.9) label = '打击（鼓）为主'; // 能量一下一下忽大忽小
    else if (share.low > 0.55) label = '低音为主';
    else if (share.mid > 0.6) label = '人声/旋律（中频）为主';
    else if (share.high > 0.45) label = '高频为主';
    else label = '全频混合';
    return { did: w.did, snr, share, cv: f.cv, label };
  });
}
