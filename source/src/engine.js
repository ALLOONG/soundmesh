// 播放引擎：解码/合成音频、把“控制端时钟”换算成 AudioContext 时间、精确调度、漂移修正
import { synthBuffer } from './synth.js';
import { makeSweep } from './calib.js';
import { makeChirp } from './calib.js';

const DRIFT_LIMIT_MS = 35;
const START_LEAD_MS = 150;

// 移动音效里虚拟声源在时间 t 的方位角（度，0 = 正前方，正 = 右）
export function motionAngle(mo, t) {
  const frac = ((((t - mo.t0) / 1000) / mo.p) % 1 + 1) % 1;
  if (mo.y === 'pingpong') return -90 + 180 * (frac < 0.5 ? frac * 2 : 2 - frac * 2);
  return -180 + frac * 360;
}

// 实时音频播放器（在音频线程里运行）：一条按“采样点编号”索引的环形时间线。
// 收到的每段声音按它该播的确切采样点写进去，音频线程连续往外读——段与段之间没有接缝，不会多一个或少一个采样点。
const PLAYER_SRC = `
// 丢包补偿也在这里做：一发现某个采样点没有数据，立刻把刚播过的 20ms 倒着放并淡出；
// 数据回来时再用 4ms 交叉淡入。因为是在音频线程里逐个采样点判断，不受网页忙不忙影响，绝不会硬切。
const CL = 960, FI = 192, H = 2048;
class SMLivePlayer extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ch = o.processorOptions.ch; this.size = 1 << 18; this.mask = this.size - 1; this.hi = 0;
    this.ring = []; this.hist = []; this.cbuf = [];
    for (let c = 0; c < this.ch; c++) { this.ring.push(new Float32Array(this.size)); this.hist.push(new Float32Array(H)); this.cbuf.push(new Float32Array(CL)); }
    this.valid = new Uint8Array(this.size);
    this.hpos = 0; this.hcount = 0; this.missing = true; this.concealing = false; this.ck = 0; this.fade = 0; this.conceals = 0;
    this.port.onmessage = (e) => {
      const m = e.data, mask = this.mask, lim = currentFrame + this.size - 256;
      if (m.w) {
        const f = m.f, n = m.w[0].length;
        for (let i = Math.max(0, currentFrame - f); i < n; i++) {
          const fi = f + i; if (fi >= lim) break;
          const j = fi & mask; this.valid[j] = 1;
          for (let c = 0; c < this.ch; c++) this.ring[c][j] = (m.w[c] || m.w[0])[i];
        }
        if (f + n > this.hi) this.hi = f + n;
      } else if (m.cut !== undefined) {
        const T = m.cut, k = m.fade || 192;
        for (let fi = Math.max(currentFrame, T - k); fi < T; fi++) for (let c = 0; c < this.ch; c++) this.ring[c][fi & mask] *= (T - fi) / k;
        for (let fi = Math.max(currentFrame, T); fi < Math.min(this.hi, lim); fi++) { const j = fi & mask; this.valid[j] = 0; for (let c = 0; c < this.ch; c++) this.ring[c][j] = 0; }
      } else if (m.clear) { for (const r of this.ring) r.fill(0); this.valid.fill(0); this.hi = 0; this.missing = true; this.concealing = false; this.hcount = 0; }
      else if (m.stats) this.port.postMessage({ conceals: this.conceals });
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], n = out[0].length, mask = this.mask, ch = this.ch;
    for (let i = 0; i < n; i++) {
      const j = (currentFrame + i) & mask;
      if (this.valid[j]) {
        if (this.missing) { this.missing = false; this.fade = FI; }
        let g = 1;
        if (this.fade > 0) { g = 1 - this.fade / FI; this.fade--; }
        for (let c = 0; c < ch; c++) {
          let v = this.ring[c][j];
          if (g < 1) v = v * g + (this.concealing && this.ck < CL ? this.cbuf[c][this.ck] * (1 - this.ck / CL) : 0) * (1 - g);
          this.hist[c][this.hpos] = v;
          if (c < out.length) out[c][i] = v;
        }
        if (g < 1) this.ck++; else this.concealing = false;
        this.hpos = (this.hpos + 1) & (H - 1); if (this.hcount < H) this.hcount++;
      } else {
        if (!this.missing) {
          // 刚断：把最近的 20ms 倒过来准备好（从倒数第二个采样点开始，接缝处波形连续）
          this.missing = true; this.ck = 0; this.concealing = this.hcount >= CL + 2;
          if (this.concealing) { this.conceals++; for (let c = 0; c < ch; c++) for (let k = 0; k < CL; k++) this.cbuf[c][k] = this.hist[c][(this.hpos - 2 - k + 2 * H) & (H - 1)]; }
        }
        for (let c = 0; c < ch; c++) if (c < out.length) out[c][i] = this.concealing && this.ck < CL ? this.cbuf[c][this.ck] * (1 - this.ck / CL) : 0;
        if (this.concealing) this.ck++;
      }
      this.valid[j] = 0; for (let c = 0; c < ch; c++) this.ring[c][j] = 0;
    }
    for (let c = ch; c < out.length; c++) out[c].set(out[ch - 1]);
    return true;
  }
}
registerProcessor('sm-live-player', SMLivePlayer);
`;

export class Engine extends EventTarget {
  constructor(clock, { fetchFile } = {}) {
    super();
    this.clock = clock; // { now(): 控制端时钟毫秒, synced: bool }
    this.fetchFile = fetchFile; // (id) => Promise<ArrayBuffer>，从控制端拉取文件
    this.liveIns = new Map(); this.liveVoices = []; this.liveSig = null; this.liveCursor = new Map();
    this.liveStats = { got: 0, late: 0, resyncs: 0, err: null };
    this.liveSources = new Set();
    const AC = window.AudioContext || window.webkitAudioContext;
    // 统一用 48kHz：和传输的音频一致，不用在播放时用粗糙的线性插值换采样率
    // （硬件不是 48k 的手机，由浏览器在最后输出时用高质量方式转换）
    try { this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 }); } catch { this.ctx = new AC({ latencyHint: 'interactive' }); }
    this.master = this.ctx.createGain();
    // 防破音：音量开到 100% 以上时，超过 -1dB 的峰值被圆滑地压住（不会硬切成“沙沙”声）；
    // 平时（-1dB 以下）完全原样通过，一个采样点都不改
    this.limIn = this.ctx.createGain(); this.limIn.gain.value = 0.5;
    this.limiter = this.ctx.createWaveShaper();
    { const n = 8193, c = new Float32Array(n), t = 0.891;
      for (let i = 0; i < n; i++) { const s = ((i / (n - 1)) * 2 - 1) * 2, a = Math.abs(s);
        c[i] = a <= t ? s : Math.sign(s) * (t + (1 - t) * Math.tanh((a - t) / (1 - t))); }
      this.limiter.curve = c; this.limiter.oversample = 'none'; }
    this.master.connect(this.limIn); this.limIn.connect(this.limiter); this.limiter.connect(this.ctx.destination);
    // 载入实时音频播放器（不支持的老浏览器自动用旧方式）
    this.livePlayers = new Map(); this.wl = false;
    try {
      const url = URL.createObjectURL(new Blob([PLAYER_SRC], { type: 'application/javascript' }));
      this.ctx.audioWorklet?.addModule(url).then(() => { this.wl = true; }).catch(() => {});
    } catch {}
    this.deviceGain = this.ctx.createGain();
    this.motionGain = this.ctx.createGain(); // 环绕移动音效：在设备增益之后再乘一层随时间变化的增益
    this.hushGain = this.ctx.createGain(); // 暂停检测：音源一暂停就立刻静音
    this.deviceGain.connect(this.motionGain);
    this.motionGain.connect(this.hushGain);
    this.hushGain.connect(this.master);
    this.motionTimer = setInterval(() => this.tickMotion(), 40);
    this.unlocked = false;
    this.buffers = new Map(); // src -> { promise, buffer, error }
    this.localFiles = new Map(); // 'local:...' -> File
    this.voices = [];
    this.sig = null;
    this.anchor = null;
    this.drift = null;
    this.resyncs = 0;
    this.error = null;
    this.cur = null; // { group, plan, pb }
    this.driftTimer = setInterval(() => this.checkDrift(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.unlocked) return;
      // 回到前台：只有声音真的被系统暂停了才重新排播放；还在正常播放就不动它（避免每次切回来都断一下）
      const wasRunning = this.ctx.state === 'running';
      this.ctx.resume().catch(() => {});
      if (!wasRunning) { this.sig = null; this.apply(); }
    });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  // 把开始时间对齐到整数采样点：浏览器遇到“半个采样点”的开始时间会做插值，悄悄削掉高音
  at(t) { const sr = this.ctx.sampleRate; return Math.round(t * sr) / sr; }

  async unlock() { // 必须在点击事件里调用
    await this.ctx.resume();
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.ctx.destination); s.start();
    this.unlocked = true;
    this.sig = null;
    this.apply();
  }

  // 后台播放模式（实验）：把声音改由一个 <audio> 元素播出。手机系统会把它当成“正在播放的媒体”，
  // 切到别的应用、甚至锁屏后通常也能继续放。代价：多一段系统缓冲，延迟会变大一点，开启后建议重新校准。
  async setBackgroundMode(on) {
    if (on === !!this.bgMode) return;
    const out = this.limiter; // 最后一级（防破音）之后才分流到不同的出口
    try { out.disconnect(); } catch {}
    if (on) {
      this.bgDest = this.bgDest || this.ctx.createMediaStreamDestination();
      out.connect(this.bgDest);
      if (!this.bgEl) { this.bgEl = new Audio(); this.bgEl.setAttribute('playsinline', ''); }
      this.bgEl.srcObject = this.bgDest.stream;
      try { await this.bgEl.play(); } catch (e) {
        out.disconnect(); out.connect(this.ctx.destination);
        throw e;
      }
    } else {
      try { this.bgEl?.pause(); } catch {}
      out.connect(this.ctx.destination);
    }
    this.bgMode = on;
  }

  beep() {
    if (!this.unlocked) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.4);
  }

  // 校准期间先把音乐静音，避免干扰录音
  duck(untilClockMs) {
    const t = this.ctx.currentTime, end = Math.max(t, this.clockToCtx(untilClockMs));
    this.duckUntil = end;
    const g = this.deviceGain.gain;
    g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.03);
    g.setTargetAtTime(this.cur?.plan?.gain ?? 1, end, 0.1);
  }

  // 环绕移动音效：一个“虚拟声源”绕着听众转（circle）或左右来回扫（pingpong），
  // 离它越近的设备越响。每台设备用自己的方位角和统一时钟独立计算，不需要网络传输每一帧
  tickMotion() {
    const mo = this.cur?.mo, az = this.cur?.plan?.az;
    const g = this.motionGain.gain, t = this.ctx.currentTime;
    if (!mo || az === undefined || az === null || !this.clock.synced) {
      if (this.motionOn) { g.cancelScheduledValues(t); g.setTargetAtTime(1, t, 0.1); this.motionOn = false; }
      return;
    }
    this.motionOn = true;
    const at = this.clock.now() + 80;
    const th = motionAngle(mo, at);
    let d = Math.abs(az - th) % 360; if (d > 180) d = 360 - d;
    const lobe = Math.pow((1 + Math.cos((d * Math.PI) / 180)) / 2, 3);
    const val = 1 - mo.d + mo.d * lobe;
    g.setTargetAtTime(val, Math.max(t, this.clockToCtx(at)), 0.05);
  }

  // 音源暂停了：马上淡出（不再把缓冲里剩下的声音放完）。恢复：在恢复那一段该出声的时刻淡入
  hush(on, at) {
    const g = this.hushGain.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    if (on) { g.setTargetAtTime(0, t, 0.015); return; }
    const when = at ? Math.max(t, this.clockToCtx(at + (this.cur?.ld || 350) + (this.cur?.plan?.D || 0)) - 0.02) : t;
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(1, when, 0.01);
  }

  // 分工检查：只在 [from, to) 这段时间出声，其余时间（到 end 为止）静音
  solo(from, to, end) {
    const t = this.ctx.currentTime, g = this.deviceGain.gain, plan = this.cur?.plan?.gain ?? 1;
    const c = (ms) => Math.max(t, this.clockToCtx(ms));
    this.duckUntil = c(end);
    g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.03);
    g.setTargetAtTime(plan, c(from), 0.05);
    g.setTargetAtTime(0, c(to), 0.05);
    g.setTargetAtTime(plan, c(end), 0.1);
  }

  // 测设备特长用的扫频：不经过音量（测的是设备本身能放出什么）
  playSweepAt(at) {
    if (!this.unlocked || this.ctx.state !== 'running') return false;
    if (!this.sweepBuf) {
      const c = makeSweep(this.ctx.sampleRate);
      this.sweepBuf = this.ctx.createBuffer(1, c.length, this.ctx.sampleRate);
      this.sweepBuf.copyToChannel(c, 0);
    }
    const when = this.clockToCtx(at);
    if (when < this.ctx.currentTime + 0.01) return false;
    const s = this.ctx.createBufferSource(); s.buffer = this.sweepBuf; s.connect(this.master); s.start(this.at(when));
    return true;
  }

  // 校准用：在控制端时间 at（再加本机当前的总延迟，和放音乐时一样）播放一声“啾”
  // raw = true：校准第一步，不套用“延迟微调”（量的是这台设备真实的延迟，不受以前设的数值影响）
  playChirpAt(at, raw = false) {
    if (!this.unlocked || this.ctx.state !== 'running') return false;
    if (!this.chirpBuf) {
      const c = makeChirp(this.ctx.sampleRate);
      this.chirpBuf = this.ctx.createBuffer(1, c.length, this.ctx.sampleRate);
      this.chirpBuf.copyToChannel(c, 0);
    }
    const p = this.cur?.plan, when = this.clockToCtx(at + (raw ? p?.posDelay || 0 : p?.D || 0));
    if (when < this.ctx.currentTime + 0.01) return false;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = this.chirpBuf; g.gain.value = 0.9;
    s.connect(g).connect(this.master);
    s.start(this.at(when));
    return true;
  }

  // ---------- 音频来源 ----------
  provideLocal(src, file) {
    this.localFiles.set(src, file);
    this.buffers.delete(src);
    this.apply();
  }
  missingLocal() {
    const g = this.cur?.group, p = this.cur?.plan;
    if (!g || !p) return [];
    const need = new Set(p.sources.map((s) => s.src));
    return g.tracks.filter((t) => need.has(t.src) && t.src.startsWith('local:') && !this.localFiles.has(t.src));
  }
  loadTrack(track) {
    const src = track.src;
    let e = this.buffers.get(src);
    if (e) return e;
    if (src.startsWith('local:') && !this.localFiles.has(src)) return null;
    e = {};
    e.promise = (async () => {
      if (src.startsWith('synth:')) {
        await new Promise((r) => setTimeout(r, 0));
        return synthBuffer(this.ctx, src.slice(6));
      }
      let data;
      if (src.startsWith('local:')) data = await this.localFiles.get(src).arrayBuffer();
      else if (src.startsWith('file:')) data = (await this.fetchFile(src.slice(5))).slice(0);
      else {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`下载失败 ${res.status}`);
        data = await res.arrayBuffer();
      }
      return await new Promise((ok, bad) => this.ctx.decodeAudioData(data, ok, bad));
    })().then(
      (buf) => { e.buffer = buf; this.emit('status'); this.apply(); return buf; },
      (err) => { e.error = err?.message || '解码失败'; this.error = `音频加载失败：${e.error}`; this.emit('status'); },
    );
    this.buffers.set(src, e);
    this.emit('status');
    return e;
  }
  gcBuffers(keep) {
    for (const k of this.buffers.keys()) if (!keep.has(k)) this.buffers.delete(k);
  }
  get loadInfo() {
    const p = this.cur?.plan;
    if (!p || this.cur.group?.kind === 'live') return { needed: 0, loaded: 0 };
    const srcs = [...new Set(p.sources.map((s) => s.src))];
    return { needed: srcs.length, loaded: srcs.filter((s) => this.buffers.get(s)?.buffer).length };
  }

  // ---------- 时间换算 ----------
  outputCtxNow() {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0 && this.ctx.state === 'running') {
      // 手机浏览器给的“播放时间”每次会跳几毫秒：不直接用，而是平滑成一条稳定的对应关系
      // （声卡和系统时钟的快慢差会被慢慢跟上；突然变很多——比如切后台回来——就直接采用新值）
      const pn = performance.now(), off = ts.contextTime - ts.performanceTime / 1000;
      if (this.mapOff === undefined || Math.abs(off - this.mapOff) > 0.02) this.mapOff = off;
      else this.mapOff += (off - this.mapOff) * 0.03;
      return this.mapOff + pn / 1000;
    }
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  }
  clockToCtx(ms) { // 控制端时钟 -> AudioContext 时间
    return this.outputCtxNow() + (ms - this.clock.now()) / 1000;
  }

  // ---------- 核心 ----------
  update(cur) { this.cur = cur; this.apply(); }

  apply() {
    const cur = this.cur;
    if (!cur || !cur.plan || !cur.group) { this.stopAll(); this.sig = null; return; }
    const { group, plan, pb } = cur;
    if (group.kind === 'live') { // 实时音源：不调度文件，只准备好处理链，等音频分段推进来
      this.stopAll(); this.sig = null;
      this.gcBuffers(new Set());
      this.ensureLiveGraph(plan);
      this.updateParams(plan);
      return;
    }
    this.teardownLive();
    this.gcBuffers(new Set(group.tracks.map((t) => t.src)));
    const needed = [...new Set(plan.sources.map((s) => s.src))];
    for (const src of needed) {
      const t = group.tracks.find((x) => x.src === src);
      if (t) this.loadTrack(t);
    }
    const sig = JSON.stringify({
      g: group.id, s: pb.status, st: pb.S, so: pb.o,
      src: plan.sources.map((s) => [s.src, s.mix.type, s.mix.index, s.filters.map((f) => f.type)]),
    });
    const allLoaded = needed.every((s) => this.buffers.get(s)?.buffer);
    const delayChanged = this.anchor && Math.abs(this.anchor.D - plan.D) > 5;
    if (sig !== this.sig || delayChanged || (!this.voices.length && pb.status === 'playing')) {
      this.stopAll();
      if (pb.status === 'playing' && allLoaded && this.unlocked && this.clock.synced) {
        this.sig = sig;
        this.schedule(group, plan, pb);
      } else this.sig = pb.status === 'playing' ? null : sig;
    }
    this.updateParams(plan);
  }

  schedule(group, plan, pb) {
    const D = plan.D;
    // 这台设备在控制端时间 T 应播放位置 p：p = o + (T - S - D)/1000
    const T = Math.max(this.clock.now() + START_LEAD_MS, pb.S + D);
    let p = pb.o + (T - pb.S - D) / 1000;
    if (!group.loop && p >= group.duration) return;
    let ctxT = this.clockToCtx(T);
    const now = this.ctx.currentTime;
    if (ctxT < now + 0.02) { p += now + 0.05 - ctxT; ctxT = now + 0.05; }
    plan.sources.forEach((s, idx) => {
      const buf = this.buffers.get(s.src)?.buffer;
      if (!buf) return;
      const off = group.loop ? p % buf.duration : p;
      if (off >= buf.duration) return;
      const v = this.buildVoice(buf, s, group.loop);
      v.idx = idx;
      { const sr = this.ctx.sampleRate; v.src.start(this.at(ctxT), Math.round(Math.max(0, off) * sr) / sr); }
      this.voices.push(v);
    });
    this.anchor = { ctxT, p, D };
    this.drift = 0;
  }

  buildVoice(buf, s, loop) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = !!loop;
    const v = this.buildChain(src, buf.numberOfChannels, s);
    v.src = src;
    return v;
  }

  // 输入节点 -> （取 L/R 混合或某个声道）-> 滤波 -> 设备增益
  buildChain(input, n, s) {
    const ctx = this.ctx;
    const v = { gL: null, gR: null, filters: [], nodes: [] };
    let out;
    if (s.mix.type === 'stereo' || n === 1) out = input;
    else {
      const mono = ctx.createGain();
      mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const split = ctx.createChannelSplitter(n);
      input.connect(split);
      v.nodes.push(mono, split);
      if (s.mix.type === 'ch') split.connect(mono, Math.min(n - 1, s.mix.index || 0));
      else {
        v.gL = ctx.createGain(); v.gR = ctx.createGain();
        v.gL.gain.value = s.mix.wl; v.gR.gain.value = s.mix.wr;
        split.connect(v.gL, 0); split.connect(v.gR, 1);
        v.gL.connect(mono); v.gR.connect(mono);
        v.nodes.push(v.gL, v.gR);
      }
      out = mono;
    }
    for (const f of s.filters) { // 两级串联 = 24dB/oct
      const nodes = [0, 1].map(() => {
        const b = ctx.createBiquadFilter();
        b.type = f.type; b.frequency.value = f.freq; b.Q.value = 0.707;
        return b;
      });
      out.connect(nodes[0]); nodes[0].connect(nodes[1]); out = nodes[1];
      v.filters.push(nodes); v.nodes.push(...nodes);
    }
    out.connect(this.deviceGain);
    v.out = out;
    return v;
  }

  // ---------- 实时音源 ----------
  ensureLiveGraph(plan) {
    const sig = JSON.stringify(plan.sources.map((s) => [s.src, s.mix.type, s.mix.index, s.filters.map((f) => f.type)]));
    if (sig === this.liveSig && this.liveIns.size) return;
    this.teardownLive();
    this.liveSig = sig;
    this.liveVoices = plan.sources.map((s, idx) => {
      const ch = s.src === 'live' ? 2 : 1;
      let input = this.liveIns.get(s.src);
      if (!input) {
        input = this.ctx.createGain();
        input.channelCount = ch; input.channelCountMode = 'explicit';
        this.liveIns.set(s.src, input);
      }
      return Object.assign(this.buildChain(input, ch, s), { idx });
    });
  }
  teardownLive() {
    if (!this.liveIns.size && !this.liveVoices.length) return;
    for (const it of this.liveSources) { try { it.src.stop(); } catch {} }
    for (const t of (this.liveWd || new Map()).values()) clearTimeout(t);
    this.liveSources.clear();
    for (const n of this.liveIns.values()) try { n.disconnect(); } catch {}
    for (const p of this.livePlayers.values()) try { p.port.postMessage({ clear: 1 }); p.disconnect(); } catch {}
    this.livePlayers = new Map(); this.liveCursorF = new Map(); this.liveStateW = new Map();
    for (const v of this.liveVoices) { try { v.out.disconnect(); } catch {} v.nodes.forEach((n) => { try { n.disconnect(); } catch {} }); }
    this.liveIns = new Map(); this.liveVoices = []; this.liveSig = null; this.liveCursor = new Map();
  }
  // 收到一段实时音频：在“采集时刻 + 统一缓冲延迟 + 本机延迟”播出
  // 把一段声音拉长/缩短几个采样点（三次插值，首尾采样点不变，所以和前后段无缝衔接）。
  // 不用浏览器的 playbackRate：它变速时首尾会多出/少掉一个采样点，和下一段叠在一起就是“喀”
  stretch(buffer, M) {
    const N = buffer.length, out = this.ctx.createBuffer(buffer.numberOfChannels, M, buffer.sampleRate), k = (N - 1) / (M - 1);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const x = buffer.getChannelData(c), y = out.getChannelData(c);
      for (let j = 0; j < M; j++) {
        const p = j * k, i = Math.floor(p), t = p - i;
        const x0 = x[i > 0 ? i - 1 : 0], x1 = x[i], x2 = x[i + 1 < N ? i + 1 : N - 1], x3 = x[i + 2 < N ? i + 2 : N - 1];
        y[j] = x1 + 0.5 * t * (x2 - x0 + t * (2 * x0 - 5 * x1 + 4 * x2 - x3 + t * (3 * (x1 - x2) + x3 - x0)));
      }
    }
    return out;
  }

  // 排一段声音：每段都有自己的音量节点，方便在接缝处淡入/淡出（避免“喀”声）
  liveSchedule(srcName, buffer, when, rate, fadeIn, fadeOut) {
    const input = this.liveIns.get(srcName);
    if (!input) return null;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(g); g.connect(input);
    const dur = buffer.duration / rate, end = this.at(when + dur);
    if (fadeIn) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + Math.min(fadeIn, dur)); }
    if (fadeOut) { g.gain.setValueAtTime(1, Math.max(when, end - fadeOut)); g.gain.linearRampToValueAtTime(0, end); }
    src.start(when);
    const it = { src, g, start: when, end, srcName };
    src.onended = () => { this.liveSources.delete(it); try { src.disconnect(); g.disconnect(); } catch {} };
    this.liveSources.add(it);
    return it;
  }

  // 在时刻 T 把这个来源已经排好的声音收掉：还没开始的直接取消，正在响的在 T 之前 4ms 淡出
  liveCut(srcName, T) {
    const now = this.ctx.currentTime;
    for (const it of this.liveSources) {
      if (it.srcName !== srcName || it.end <= T) continue;
      if (it.start >= T - 0.0005 && it.start > now + 0.003) { try { it.src.stop(); } catch {} this.liveSources.delete(it); continue; }
      const a = Math.max(now + 0.001, T - 0.004);
      try { it.g.gain.cancelScheduledValues(a); it.g.gain.setValueAtTime(it.g.gain.value, a); it.g.gain.linearRampToValueAtTime(0, Math.max(a + 0.001, T)); it.src.stop(Math.max(a + 0.002, T) + 0.002); } catch {}
    }
  }

  // 丢包补偿：用上一段声音“倒着放”补上缺的部分（接缝处波形连续，不会喀），同时慢慢淡出
  liveConceal(srcName, at, len) {
    const last = this.liveLast?.get(srcName);
    if (!last || len <= 0) return;
    const n = last.length, m = Math.min(n, Math.round(len * this.ctx.sampleRate));
    const b = this.ctx.createBuffer(last.numberOfChannels, m, this.ctx.sampleRate);
    for (let c = 0; c < last.numberOfChannels; c++) {
      const src = last.getChannelData(c), dst = b.getChannelData(c);
      for (let i = 0; i < m; i++) dst[i] = src[n - 1 - i];
    }
    this.liveSchedule(srcName, b, this.at(at), 1, 0, m / this.ctx.sampleRate);
    this.liveStats.concealed = (this.liveStats.concealed || 0) + 1;
  }

  pushLive(ts, buffer, srcName = 'live') {
    if (this.wl) return this.pushLiveW(ts, buffer, srcName);
    const cur = this.cur;
    const input = this.liveIns.get(srcName);
    if (!this.unlocked || !this.clock.synced || !cur?.plan || cur.group?.kind !== 'live' || !input) return;
    this.liveStats.got++;
    const expected = this.clockToCtx(ts + (cur.ld || 350) + cur.plan.D);
    const now = this.ctx.currentTime;
    if (expected + buffer.duration < now + 0.005) { this.liveStats.late++; return; } // 来得太晚，丢掉
    const wd = this.liveWd || (this.liveWd = new Map()), last = this.liveLast || (this.liveLast = new Map());
    const st = this.liveState || (this.liveState = new Map());
    clearTimeout(wd.get(srcName));
    let when, rate = 1, fadeIn = 0;
    const cursor = this.liveCursor.get(srcName) ?? null;
    const gap = cursor === null ? null : expected - cursor;
    const ema = this.liveErr || (this.liveErr = new Map());
    if (cursor === null || st.get(srcName) === 'gap' || gap < -0.04 || gap > 0.25) {
      // 重新对齐（刚开始 / 网络卡太久之后 / 误差太大）：把旧的声音在接点淡出，新的淡入
      when = this.at(Math.max(expected, now + 0.005));
      if (cursor !== null) this.liveCut(srcName, when);
      fadeIn = cursor === null ? 0.01 : 0.004;
      if (cursor !== null) this.liveStats.resyncs++;
      ema.set(srcName, 0);
    } else if (gap > 0.004) {
      // 中间少了一段（控制端因为网络塞车丢掉的）：补上那一段，时间线不动，新的一段淡入
      this.liveConceal(srcName, cursor, gap);
      when = this.at(expected);
      fadeIn = 0.004;
    } else {
      // 紧接上一段播放（无缝）。平时完全按原速、逐个采样点原样播放（音质 100% 不变）；
      // 误差（先做约 1 秒的平均，滤掉时间读数抖动）累积到 1 个采样点（0.02ms）以上时，
      // 才让这一段多放或少放 1 个采样点（只这 20ms 变速 0.1%，听不出），各设备都稳定在 0.5ms 以内。
      // 只有缓冲刚调整、误差超过 15ms 时，每段最多调 3 个采样点（0.3%）快速追上。
      when = this.at(cursor);
      const sr = this.ctx.sampleRate, raw = cursor - expected;
      let e = (ema.get(srcName) ?? raw) * 0.95 + raw * 0.05;
      const es = e * sr;
      let d = 0;
      if (Math.abs(e) > 0.015) d = Math.sign(es) * 3;
      else if (Math.abs(es) >= 1.5) d = Math.sign(es);
      if (d) { buffer = this.stretch(buffer, buffer.length - d); e -= d / sr; }
      ema.set(srcName, e);
    }
    st.set(srcName, 'ok');
    this.liveSchedule(srcName, buffer, when, rate, fadeIn, 0);
    const end = this.at(when + buffer.duration / rate); // 一段占整数个采样点，下一段的起点也落在采样点上
    this.liveCursor.set(srcName, end);
    last.set(srcName, buffer);
    this.liveStats.err = (when - expected) * 1000;
    // 看门狗：快播到这一段结尾了，下一段还没到（网络卡住）→ 提前补一段并淡出，之后静音，等数据回来再淡入
    const ms = (end - this.ctx.currentTime - 0.03) * 1000;
    wd.set(srcName, setTimeout(() => {
      if (this.liveCursor.get(srcName) !== end || st.get(srcName) === 'gap') return;
      this.liveConceal(srcName, end, buffer.duration);
      st.set(srcName, 'gap');
    }, Math.max(0, ms)));
  }

  // ---------- 新方式：写进音频线程里的连续时间线（采样点精确） ----------
  player(srcName, ch) {
    let p = this.livePlayers.get(srcName);
    if (!p) {
      const input = this.liveIns.get(srcName);
      if (!input) return null;
      p = new AudioWorkletNode(this.ctx, 'sm-live-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [ch], processorOptions: { ch } });
      p.connect(input);
      this.livePlayers.set(srcName, p);
    }
    return p;
  }
  stretchArr(planes, M) {
    const N = planes[0].length, k = (N - 1) / (M - 1);
    return planes.map((x) => {
      const y = new Float32Array(M);
      for (let j = 0; j < M; j++) {
        const p = j * k, i = Math.floor(p), t = p - i;
        const x0 = x[i > 0 ? i - 1 : 0], x1 = x[i], x2 = x[i + 1 < N ? i + 1 : N - 1], x3 = x[i + 2 < N ? i + 2 : N - 1];
        y[j] = x1 + 0.5 * t * (x2 - x0 + t * (2 * x0 - 5 * x1 + 4 * x2 - x3 + t * (3 * (x1 - x2) + x3 - x0)));
      }
      return y;
    });
  }
  // 丢包补偿：上一段声音倒着放（接缝处波形连续），同时淡出到 0
  concealW(p, srcName, atF, len) {
    const last = this.liveLastW?.get(srcName);
    if (!last || len <= 0) return;
    const n = last[0].length, m = Math.min(n, len);
    const w = last.map((x) => { const y = new Float32Array(m); for (let i = 0; i < m; i++) y[i] = x[n - 1 - i] * (1 - (i + 1) / m); return y; });
    p.port.postMessage({ f: atF, w }, w.map((a) => a.buffer));
    this.liveStats.concealed = (this.liveStats.concealed || 0) + 1;
  }
  pushLiveW(ts, buffer, srcName) {
    const cur = this.cur;
    if (!this.unlocked || !this.clock.synced || !cur?.plan || cur.group?.kind !== 'live' || !this.liveIns.get(srcName)) return;
    const ch = buffer.numberOfChannels, p = this.player(srcName, ch);
    if (!p) return;
    this.liveStats.got++;
    const sr = this.ctx.sampleRate, N = buffer.length;
    const expF = Math.round(this.clockToCtx(ts + (cur.ld || 350) + cur.plan.D) * sr);
    const minF = Math.round((this.ctx.currentTime + 0.012) * sr); // 至少提前 12ms 交给音频线程
    if (expF + N < minF) { this.liveStats.late++; return; } // 来得太晚，丢掉
    const curs = this.liveCursorF || (this.liveCursorF = new Map()), st = this.liveStateW || (this.liveStateW = new Map());
    const wd = this.liveWd || (this.liveWd = new Map()), lastM = this.liveLastW || (this.liveLastW = new Map());
    const ema = this.liveErr || (this.liveErr = new Map());
    let planes = []; for (let c = 0; c < ch; c++) planes.push(buffer.getChannelData(c).slice());
    const cursor = curs.get(srcName) ?? null, gap = cursor === null ? null : expF - cursor;
    let startF, fadeIn = 0;
    if (cursor === null || cursor < minF || gap < -0.04 * sr || gap > 0.25 * sr) {
      // 重新对齐（刚开始 / 网络卡太久之后 / 误差太大）：旧的在接点淡出，新的淡入
      startF = Math.max(expF, minF);
      if (cursor !== null) { p.port.postMessage({ cut: startF, fade: 192 }); this.liveStats.resyncs++; }
      fadeIn = cursor === null ? 480 : 192;
      ema.set(srcName, 0);
      if (startF > expF) { const skip = startF - expF; if (skip >= N) return; planes = planes.map((x) => x.subarray(skip)); }
    } else if (gap >= N / 2) {
      // 中间少了一段（控制端因为网络塞车丢掉的）：时间线不动，照常写在它该在的位置；
      // 缺的那一小段由音频线程自动补偿、淡出，再交叉淡入这一段
      startF = expF;
      this.liveStats.concealed = (this.liveStats.concealed || 0) + 1;
    } else {
      // 紧接上一段，逐个采样点原样播放；误差累积到 1.5 个采样点（0.03ms）才让这一段多/少 1 个采样点
      startF = cursor;
      const raw = cursor - expF;
      let e = (ema.get(srcName) ?? raw) * 0.95 + raw * 0.05, d = 0;
      // 平时每段最多调 1 个采样点（0.1%，约 1.7 音分，听不出）；只有误差超过 15ms（缓冲刚调整）才用 3 个（0.3%）
      if (Math.abs(e) > 0.015 * sr) d = Math.sign(e) * 3;
      else if (Math.abs(e) >= 1.5) d = Math.sign(e);
      if (d) { planes = this.stretchArr(planes, N - d); e -= d; }
      ema.set(srcName, e);
    }
    if (fadeIn) { const k = Math.min(fadeIn, planes[0].length); for (const x of planes) for (let i = 0; i < k; i++) x[i] *= i / k; }
    const len = planes[0].length;
    lastM.set(srcName, planes.map((x) => x.slice()));
    p.port.postMessage({ f: startF, w: planes }, planes.map((a) => a.buffer));
    st.set(srcName, 'ok');
    const end = startF + len;
    curs.set(srcName, end);
    this.liveStats.err = ((startF - expF) / sr) * 1000;
  }

  updateParams(plan) {
    const t = this.ctx.currentTime;
    if (!(this.duckUntil > t)) this.deviceGain.gain.setTargetAtTime(plan.gain, t, 0.04);
    for (const v of [...this.voices, ...this.liveVoices]) {
      const s = plan.sources[v.idx];
      if (!s) continue;
      if (v.gL && s.mix.type === 'lr') {
        v.gL.gain.setTargetAtTime(s.mix.wl, t, 0.04);
        v.gR.gain.setTargetAtTime(s.mix.wr, t, 0.04);
      }
      s.filters.forEach((f, j) => v.filters[j]?.forEach((b) => b.frequency.setTargetAtTime(f.freq, t, 0.04)));
    }
  }

  stopAll() {
    for (const v of this.voices) {
      try { v.src.stop(); } catch {}
      try { v.src.disconnect(); } catch {}
      try { v.out.disconnect(); } catch {}
    }
    this.voices = [];
    this.anchor = null;
  }

  checkDrift() {
    const pb = this.cur?.pb;
    if (!this.anchor || pb?.status !== 'playing' || !this.voices.length) { this.drift = null; return; }
    const outNow = this.outputCtxNow();
    if (outNow < this.anchor.ctxT + 0.2) return;
    const expected = pb.o + (this.clock.now() - pb.S - this.anchor.D) / 1000;
    const actual = this.anchor.p + (outNow - this.anchor.ctxT);
    this.drift = (actual - expected) * 1000;
    if (Math.abs(this.drift) > DRIFT_LIMIT_MS) { this.resyncs++; this.sig = null; this.apply(); }
  }

  destroy() {
    clearInterval(this.driftTimer);
    clearInterval(this.motionTimer);
    this.stopAll();
    this.teardownLive();
    this.ctx.close();
  }
}
