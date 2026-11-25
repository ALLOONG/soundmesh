// 实时拆声部：把立体声实时音频拆成 人声 / 鼓 / 贝斯 / 伴奏 四条单声道
// 方法（浏览器里能实时跑的简化版，不是 AI 分离）：
//   贝斯 = 120Hz 以下（到 200Hz 渐变）
//   人声 = 中频段里“左右声道一模一样”的部分（人声通常混在正中间），且不是打击声
//   鼓   = 谐波/打击分离（HPSS）里“打击”的部分
//   伴奏 = 其余全部
// 每条都是立体声（同一个分离结果分别套在左、右声道上），四条加起来 = 原曲（完整重建，不丢东西）。

export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = Math.sin((2 * Math.PI * i) / n); }
  }
  run(re, im, inverse) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cos[k], s = inverse ? -this.sin[k] : this.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

export const STEMS = ['vocals', 'drums', 'bass', 'other'];
export const STEM_NAMES = { vocals: '人声', drums: '鼓/打击', bass: '贝斯/低音', other: '伴奏' };

export class Separator {
  constructor(sr = 48000, outChunk = 960) {
    this.sr = sr; this.N = 1024; this.H = 512; this.T = 9; this.F = 17; this.outChunk = outChunk;
    const N = this.N;
    this.fft = new FFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); // sqrt-Hann，50% 重叠可完美重建
    const K = N / 2 + 1;
    this.K = K;
    this.Bm = new Float64Array(K); this.Wv = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const f = (k * sr) / N;
      this.Bm[k] = f < 120 ? 1 : f < 200 ? 1 - (f - 120) / 80 : 0;
      this.Wv[k] = f < 150 ? 0 : f < 250 ? (f - 150) / 100 : f < 4500 ? 1 : f < 8000 ? 1 - (f - 4500) / 3500 : 0;
    }
    this.hist = []; // 最近 T 帧：{ Mre, Mim, mag, Vm }
    this.prevVm = new Float64Array(K);
    this.in = { L: new Float32Array(0), R: new Float32Array(0), start: null };
    this.nextFrame = null;
    this.acc = Object.fromEntries(STEMS.map((s) => [s, [new Float64Array(N * 2), new Float64Array(N * 2)]]));
    this.accStart = null;
    this.pend = Object.fromEntries(STEMS.map((s) => [s, [[], []]]));
    this.pendStart = null;
    this.tmp = { re: new Float64Array(N), im: new Float64Array(N) };
    this.median = new Float64Array(Math.max(this.T, this.F));
  }

  // 算法带来的延迟（样本）：窗口 + 往后看的 (T-1)/2 帧
  get latency() { return this.N + ((this.T - 1) / 2) * this.H; }

  push(frame, l, r) {
    const inp = this.in;
    if (inp.start === null) { inp.start = frame; this.nextFrame = frame; }
    const cat = (a, b) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
    inp.L = cat(inp.L, l); inp.R = cat(inp.R, r);
    const out = [];
    while (inp.start + inp.L.length - this.nextFrame >= this.N) {
      const off = this.nextFrame - inp.start;
      this.analyze(inp.L.subarray(off, off + this.N), inp.R.subarray(off, off + this.N), this.nextFrame, out);
      this.nextFrame += this.H;
    }
    const drop = this.nextFrame - inp.start;
    if (drop > 0) { inp.L = inp.L.slice(drop); inp.R = inp.R.slice(drop); inp.start += drop; }
    return out;
  }

  analyze(L, R, pos, out) {
    const { N, K, fft, win } = this;
    const lr = new Float64Array(N), li = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
    for (let i = 0; i < N; i++) { lr[i] = L[i] * win[i]; rr[i] = R[i] * win[i]; }
    fft.run(lr, li, false); fft.run(rr, ri, false);
    const Mre = new Float64Array(K), Mim = new Float64Array(K), mag = new Float64Array(K), Vm = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      Mre[k] = (lr[k] + rr[k]) / 2; Mim[k] = (li[k] + ri[k]) / 2;
      mag[k] = Math.hypot(Mre[k], Mim[k]);
      const al = Math.hypot(lr[k], li[k]), ar = Math.hypot(rr[k], ri[k]);
      const sim = (2 * al * ar) / (al * al + ar * ar + 1e-12); // 左右一样响 → 1
      const phase = al * ar > 1e-12 ? (lr[k] * rr[k] + li[k] * ri[k]) / (al * ar) : 0; // 相位一致 → 1
      const center = Math.max(0, sim * phase);
      const v = this.Wv[k] * Math.pow(center, 6);
      Vm[k] = 0.5 * v + 0.5 * this.prevVm[k]; // 时间上平滑，减少“水声”
      this.prevVm[k] = v;
    }
    this.hist.push({ Mre, Mim, mag, Vm, pos, lr, li, rr, ri });
    if (this.hist.length < this.T) return;
    if (this.hist.length > this.T) this.hist.shift();
    this.emitCenter(out);
  }

  emitCenter(out) {
    const { K, N, T, F, hist } = this;
    const c = hist[(T - 1) / 2];
    const med = this.median;
    const spec = {};
    for (const s of STEMS) spec[s] = [0, 1].map(() => ({ re: new Float64Array(N), im: new Float64Array(N) }));
    const chans = [[c.lr, c.li], [c.rr, c.ri]];
    for (let k = 0; k < K; k++) {
      // 谐波 = 时间方向中位数（持续的音），打击 = 频率方向中位数（瞬间的宽频冲击）
      for (let t = 0; t < T; t++) med[t] = hist[t].mag[k];
      const h = quickMedian(med, T);
      let n = 0;
      for (let j = k - (F >> 1); j <= k + (F >> 1); j++) if (j >= 0 && j < K) med[n++] = c.mag[j];
      const p = quickMedian(med, n);
      const p4 = (p * p) ** 2, h4 = (h * h) ** 2;
      const Pm = p4 / (h4 + p4 + 1e-24); // 4 次方的软掩码：比 2 次方分得更干净
      const Bm = this.Bm[k], Vm = c.Vm[k];
      const g = {
        bass: Bm,
        drums: (1 - Bm) * Pm,
        vocals: (1 - Bm) * (1 - Pm) * Vm,
        other: (1 - Bm) * (1 - Pm) * (1 - Vm),
      };
      for (const s of STEMS) for (let ch = 0; ch < 2; ch++) {
        const sp = spec[s][ch], [cr, ci] = chans[ch];
        sp.re[k] = cr[k] * g[s]; sp.im[k] = ci[k] * g[s];
        if (k > 0 && k < N / 2) { sp.re[N - k] = sp.re[k]; sp.im[N - k] = -sp.im[k]; }
      }
    }
    if (this.accStart === null) { this.accStart = c.pos; this.pendStart = c.pos; }
    const off = c.pos - this.accStart;
    for (const s of STEMS) for (let ch = 0; ch < 2; ch++) {
      const { re, im } = spec[s][ch];
      this.fft.run(re, im, true);
      const acc = this.acc[s][ch];
      for (let i = 0; i < N; i++) acc[off + i] += re[i] * this.win[i];
    }
    // c.pos 之前加上一个 hop 的样本已经叠加完毕，可以输出
    const done = off + this.H;
    for (const s of STEMS) for (let ch = 0; ch < 2; ch++) {
      const acc = this.acc[s][ch];
      for (let i = 0; i < done; i++) this.pend[s][ch].push(acc[i]);
      acc.copyWithin(0, done); acc.fill(0, acc.length - done);
    }
    this.accStart += done;
    while (this.pend.vocals[0].length >= this.outChunk) {
      const stems = {};
      for (const s of STEMS) stems[s] = [0, 1].map((ch) => Float32Array.from(this.pend[s][ch].splice(0, this.outChunk)));
      out.push({ frame: this.pendStart, stems });
      this.pendStart += this.outChunk;
    }
  }
}

function quickMedian(a, n) {
  const b = Array.prototype.slice.call(a, 0, n).sort((x, y) => x - y);
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
