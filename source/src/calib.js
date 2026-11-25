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

// ---------- 用正在播的音乐校准 ----------
// 先轻微低通再换到目标采样率（24kHz：对齐用足够，传输量小一半）
export function toRate(x, sr, out = 24000) {
  const f = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) f[i] = 0.25 * (x[i - 1] ?? x[i]) + 0.5 * x[i] + 0.25 * (x[i + 1] ?? x[i]);
  if (sr === out) return f;
  const k = sr / out, n = Math.floor((x.length - 1) / k), y = new Float32Array(n);
  for (let j = 0; j < n; j++) { const p = j * k, i = Math.floor(p), t = p - i; y[j] = f[i] * (1 - t) + f[i + 1] * t; }
  return y;
}

// GCC-PHAT：找出 y（录到的）在 x（原声）里的位置。返回最佳位移（可以是小数）和峰值清晰度
function gccPhat(y, x, maxLag, rate) {
  let N = 1; while (N < x.length + y.length) N <<= 1;
  const fft = new FFT(N);
  const yr = new Float64Array(N), yi = new Float64Array(N), xr = new Float64Array(N), xi = new Float64Array(N);
  for (let i = 0; i < y.length; i++) yr[i] = y[i];
  for (let i = 0; i < x.length; i++) xr[i] = x[i];
  fft.run(yr, yi, false); fft.run(xr, xi, false);
  const lo = Math.floor((200 / rate) * N), hi = Math.ceil((Math.min(9000, rate * 0.45) / rate) * N);
  for (let k = 0; k < N; k++) {
    const kk = k <= N / 2 ? k : N - k;
    // conj(Y)·X，再只留相位（PHAT）：对音乐这种能量集中在低频的信号，峰会变得很尖
    const r = yr[k] * xr[k] + yi[k] * xi[k], im = yr[k] * xi[k] - yi[k] * xr[k], m = Math.hypot(r, im);
    if (kk < lo || kk > hi || m < 1e-12) { yr[k] = 0; yi[k] = 0; } else { yr[k] = r / m; yi[k] = im / m; }
  }
  fft.run(yr, yi, true);
  let best = -Infinity, bi = 0;
  for (let k = 0; k <= maxLag; k++) if (yr[k] > best) { best = yr[k]; bi = k; }
  const vals = []; for (let k = 0; k <= maxLag; k++) vals.push(Math.abs(yr[k]));
  vals.sort((a, b) => a - b);
  const med = vals[vals.length >> 1] || 1e-12;
  // 第二高的峰（离最高峰 1ms 以外）：判断有没有别的声音（比如电脑本身在放原声）
  const guard = Math.round(rate * 0.001);
  let second = -Infinity, si = -1;
  for (let k = 0; k <= maxLag; k++) if (Math.abs(k - bi) > guard && yr[k] > second && yr[k] >= (yr[k - 1] ?? -Infinity) && yr[k] >= (yr[k + 1] ?? -Infinity)) { second = yr[k]; si = k; }
  const y0 = yr[bi - 1] ?? best, y2 = yr[bi + 1] ?? best, den = y0 - 2 * best + y2;
  const frac = den ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  return { lag: bi + frac, clarity: best / med, second: second > 0 ? second / best : 0, secondLag: si };
}

// mic: { rec, sr, startHost, inLat }（rec 已经是 rate 采样率）
// windows: [{ did, a, b, expect }]：a~b 是这台设备单独出声的那段（控制端时间，毫秒），
//   expect = 预计“原声第 t 毫秒”会在 t + expect 被听到（= 缓冲 + 这台设备的总延迟 + 已知的真实延迟）
// getSrc(tsFrom, n, rate)：取原声（控制端时间轴）从 tsFrom 开始 n 个采样点
// 返回每台设备的“实际听到时刻 - 原声时间”（毫秒），以及清晰度和是否有别的声音
export function alignMusic(mic, windows, getSrc, rate, search) {
  return windows.map((w) => {
    const i0 = Math.round(((w.a - mic.startHost) / 1000) * rate), i1 = Math.round(((w.b - mic.startHost) / 1000) * rate);
    if (i0 < 0 || i1 > mic.rec.length || i1 - i0 < rate * 0.5) return { did: w.did, ok: false };
    const y = mic.rec.subarray(i0, i1);
    const S = search; // 往前后各搜索 S 毫秒
    const xFrom = w.a - w.expect - S, n = (i1 - i0) + Math.round(((2 * S) / 1000) * rate);
    const x = getSrc(xFrom, n, rate);
    if (!x) return { did: w.did, ok: false };
    let e2 = 0; for (const v of y) e2 += v * v;
    const g = gccPhat(y, x, Math.round(((2 * S) / 1000) * rate), rate);
    // y[0]（时刻 a）对应原声 xFrom + lag/rate → 听到时刻 - 原声时间
    const offset = w.a - (xFrom + (g.lag / rate) * 1000) - (mic.inLat || 0) * 1000;
    const quiet = Math.sqrt(e2 / y.length) < 0.002;
    return { did: w.did, ok: !quiet && g.clarity > 8, offset, clarity: g.clarity, other: g.second > 0.5 ? { ratio: g.second, ms: ((g.secondLag - g.lag) / rate) * 1000 } : null, quiet };
  });
}

// 找“很早就出现的同一份音乐”：比如电脑自己还在放原声（不经过 SoundMesh，所以比所有设备都早）
// 在 a~b 这段录音里，搜索“原声后 lagFrom~lagTo 毫秒”有没有清楚的相关峰
export function findEarlyCopy(mic, a, b, lagFrom, lagTo, getSrc, rate) {
  const i0 = Math.round(((a - mic.startHost) / 1000) * rate), i1 = Math.round(((b - mic.startHost) / 1000) * rate);
  if (i0 < 0 || i1 > mic.rec.length || i1 - i0 < rate * 0.5 || lagTo <= lagFrom) return null;
  const y = mic.rec.subarray(i0, i1);
  const x = getSrc(a - lagTo, (i1 - i0) + Math.round(((lagTo - lagFrom) / 1000) * rate), rate);
  if (!x) return null;
  const g = gccPhat(y, x, Math.round(((lagTo - lagFrom) / 1000) * rate), rate);
  return { found: g.clarity > 10, lagMs: lagTo - (g.lag / rate) * 1000, clarity: g.clarity };
}
