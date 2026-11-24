import { FFT } from './separator.js';
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

// ---------- AI 音色校正：扫频测每台设备的频率响应，自动设计均衡器 ----------
export const SWEEP_SEC = 2.0;
export const EQ_FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// 对数扫频 30Hz → 20kHz（每个八度停留时间相同，低音也测得准）
export function makeSweep(sr, amp = 0.5) {
  const n = Math.round(sr * SWEEP_SEC), out = new Float32Array(n);
  const f0 = 30, f1 = Math.min(20000, sr * 0.45), T = SWEEP_SEC, K = Math.log(f1 / f0);
  const fade = Math.round(sr * 0.04);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = (2 * Math.PI * f0 * T / K) * (Math.exp((t / T) * K) - 1);
    const w = i < fade ? i / fade : i > n - fade ? (n - i) / fade : 1;
    out[i] = Math.sin(ph) * w * amp;
  }
  return out;
}

// 1/3 倍频程频带（25Hz–16kHz）
export const THIRD_OCT = (() => { const a = []; for (let k = -16; k <= 13; k++) a.push(1000 * 2 ** (k / 3)); return a; })();

// 一段信号的“能量谱”（Welch 平均，N 点，50% 重叠，汇总成每个频点的能量）
function energySpectrum(sig, a, b, fft, N, hann) {
  const out = new Float64Array(N / 2), re = new Float64Array(N), im = new Float64Array(N);
  for (let s = a; s < b; s += N / 2) {
    for (let i = 0; i < N; i++) { const j = s + i, v = j < b && j >= 0 && j < sig.length ? sig[j] : 0; re[i] = v * hann[i]; im[i] = 0; }
    fft.run(re, im, false);
    for (let k = 0; k < N / 2; k++) out[k] += re[k] * re[k] + im[k] * im[k];
  }
  return out;
}

// windows: [{ did, at }]（扫频开始的控制端时间）；noise: { from, to }
// 返回每台设备在 1/3 倍频程各频带的响应（dB，相对值）和该频带是否听得清
export function analyzeResponse({ rec, sr, startHost }, windows, noise) {
  const N = 8192, fft = new FFT(N), hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const idx = (t) => Math.round(((t - startHost) / 1000) * sr);
  const len = Math.round((SWEEP_SEC + 0.55) * sr); // 扫频长度 + 设备输出延迟/房间余响的余量
  const sweep = makeSweep(sr);
  const X = energySpectrum(sweep, 0, len, fft, N, hann);
  const na = Math.max(0, idx(noise.from)), nb = Math.min(rec.length, idx(noise.to));
  const Nn = energySpectrum(rec, na, nb, fft, N, hann), nScale = len / Math.max(1, nb - na);
  const binHz = sr / N;
  return windows.map((w) => {
    const a = Math.max(0, idx(w.at) - Math.round(0.05 * sr));
    const Y = energySpectrum(rec, a, Math.min(rec.length, a + len), fft, N, hann);
    const bands = THIRD_OCT.map((fc) => {
      const lo = fc / 2 ** (1 / 6), hi = fc * 2 ** (1 / 6);
      let y = 0, x = 0, nz = 0;
      for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.ceil(hi / binHz) && k < N / 2; k++) { y += Y[k]; x += X[k]; nz += Nn[k] * nScale; }
      const sig = Math.max(y - nz, 1e-20);
      return { f: fc, db: 10 * Math.log10(sig / Math.max(x, 1e-20)), snr: 10 * Math.log10((y + 1e-20) / (nz + 1e-20)) };
    });
    return { did: w.did, bands };
  });
}

// RBJ 峰值滤波器在频率 f 的增益（dB），用来预测均衡器的实际效果
function peakDb(f, f0, gDb, Q, sr) {
  const A = 10 ** (gDb / 40), w0 = (2 * Math.PI * f0) / sr, al = Math.sin(w0) / (2 * Q), cw = Math.cos(w0);
  const b0 = 1 + al * A, b1 = -2 * cw, b2 = 1 - al * A, a0 = 1 + al / A, a1 = -2 * cw, a2 = 1 - al / A;
  const w = (2 * Math.PI * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
export const EQ_Q = 1.4;
export const eqCurve = (gains, f, sr = 48000) => gains.reduce((a, g, i) => a + (g ? peakDb(f, EQ_FREQS[i], g, EQ_Q, sr) : 0), 0);

// 根据测到的响应设计 10 段均衡：把偏差往平直拉（只校正 75%，留一点设备本身的味道），
// 设备天生发不出的低音不硬补（硬补只会破音），最后整体降一点音量防止爆音。
export function designEq(bands) {
  const mid = bands.filter((b) => b.f >= 250 && b.f <= 4000 && b.snr > 6);
  if (mid.length < 5) return null; // 太小声/太吵，测不准
  const ref = mid.reduce((a, b) => a + b.db, 0) / mid.length;
  const want = EQ_FREQS.map((fc, i) => {
    const near = bands.filter((b) => b.f >= fc / Math.SQRT2 && b.f <= fc * Math.SQRT2 && b.snr > 6);
    if (!near.length) return 0;
    const dev = near.reduce((a, b) => a + b.db, 0) / near.length - ref;
    const low = fc <= 125;
    if (low && dev < -12) return 0; // 小喇叭发不出的低音：不补
    if (dev < -18) return 0;
    // 快到设备发不出的边缘（比该有的小 8dB 以上）：最多补 3dB，避免手机喇叭破音
    const maxUp = dev < -8 ? 3 : low ? 4 : i === EQ_FREQS.length - 1 ? 4 : 6, maxDown = i === EQ_FREQS.length - 1 ? -4 : -10;
    return Math.max(maxDown, Math.min(maxUp, -0.75 * dev));
  });
  // 相邻频段的滤波器会互相影响：迭代几次，让实际效果贴近目标
  let g = want.slice();
  for (let it = 0; it < 6; it++) {
    g = g.map((v, i) => {
      if (!want[i]) return 0;
      const err = want[i] - eqCurve(g, EQ_FREQS[i]);
      return Math.max(-12, Math.min(8, v + 0.7 * err));
    });
  }
  let peak = 0;
  for (let f = 25; f < 20000; f *= 1.05) peak = Math.max(peak, eqCurve(g, f));
  const r1 = (v) => Math.round(v * 10) / 10;
  return { g: g.map(r1), pre: r1(-peak - 0.5), dev: EQ_FREQS.map((fc) => { const n = bands.filter((b) => b.f >= fc / Math.SQRT2 && b.f <= fc * Math.SQRT2); return n.length ? r1(n.reduce((a, b) => a + b.db, 0) / n.length - ref) : null; }) };
}
