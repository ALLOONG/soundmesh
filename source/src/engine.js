// 播放引擎：解码/合成音频、把“控制端时钟”换算成 AudioContext 时间、精确调度、漂移修正
import { synthBuffer } from './synth.js';
import { makeChirp } from './calib.js';

const DRIFT_LIMIT_MS = 35;
const START_LEAD_MS = 150;

// 移动音效里虚拟声源在时间 t 的方位角（度，0 = 正前方，正 = 右）
export function motionAngle(mo, t) {
  const frac = ((((t - mo.t0) / 1000) / mo.p) % 1 + 1) % 1;
  if (mo.y === 'pingpong') return -90 + 180 * (frac < 0.5 ? frac * 2 : 2 - frac * 2);
  return -180 + frac * 360;
}

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
    this.master.connect(this.ctx.destination);
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
    try { this.master.disconnect(); } catch {}
    if (on) {
      this.bgDest = this.bgDest || this.ctx.createMediaStreamDestination();
      this.master.connect(this.bgDest);
      if (!this.bgEl) { this.bgEl = new Audio(); this.bgEl.setAttribute('playsinline', ''); }
      this.bgEl.srcObject = this.bgDest.stream;
      try { await this.bgEl.play(); } catch (e) {
        this.master.disconnect(); this.master.connect(this.ctx.destination);
        throw e;
      }
    } else {
      try { this.bgEl?.pause(); } catch {}
      this.master.connect(this.ctx.destination);
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

  // 校准用：在控制端时间 at（再加本机当前的总延迟，和放音乐时一样）播放一声“啾”
  playChirpAt(at) {
    if (!this.unlocked) return false;
    if (!this.chirpBuf) {
      const c = makeChirp(this.ctx.sampleRate);
      this.chirpBuf = this.ctx.createBuffer(1, c.length, this.ctx.sampleRate);
      this.chirpBuf.copyToChannel(c, 0);
    }
    const when = this.clockToCtx(at + (this.cur?.plan?.D || 0));
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
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
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
    for (const src of this.liveSources) { try { src.stop(); } catch {} }
    this.liveSources.clear();
    for (const n of this.liveIns.values()) try { n.disconnect(); } catch {}
    for (const v of this.liveVoices) { try { v.out.disconnect(); } catch {} v.nodes.forEach((n) => { try { n.disconnect(); } catch {} }); }
    this.liveIns = new Map(); this.liveVoices = []; this.liveSig = null; this.liveCursor = new Map();
  }
  // 收到一段实时音频：在“采集时刻 + 统一缓冲延迟 + 本机延迟”播出
  pushLive(ts, buffer, srcName = 'live') {
    const cur = this.cur;
    const input = this.liveIns.get(srcName);
    if (!this.unlocked || !this.clock.synced || !cur?.plan || cur.group?.kind !== 'live' || !input) return;
    this.liveStats.got++;
    const expected = this.clockToCtx(ts + (cur.ld || 350) + cur.plan.D);
    const now = this.ctx.currentTime;
    if (expected + buffer.duration < now + 0.005) { this.liveStats.late++; return; } // 来得太晚，丢掉
    let when, rate = 1;
    const cursor = this.liveCursor.get(srcName) ?? null;
    if (cursor === null || Math.abs(cursor - expected) > 0.04) {
      when = this.at(Math.max(expected, now + 0.005));
      this.liveStats.resyncs++;
    } else {
      // 紧接上一段播放（无缝）。误差 2ms 以内完全不变速（音高 100% 原样）；
      // 平时只用 ±0.07% 慢慢追（约 1 音分，人耳听不出）；只有缓冲刚调整、误差超过 15ms 时才用到 ±0.3%
      when = this.at(cursor); // 对齐到采样点（变速后的接缝最多差半个采样点，约 0.01ms，听不出）
      const err = cursor - expected, lim = Math.abs(err) > 0.015 ? 0.003 : 0.0007;
      rate = Math.abs(err) < 0.002 ? 1 : 1 + Math.max(-lim, Math.min(lim, err * 2));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(input);
    src.start(when);
    src.onended = () => { this.liveSources.delete(src); try { src.disconnect(); } catch {} };
    this.liveSources.add(src);
    this.liveCursor.set(srcName, when + buffer.duration / rate);
    this.liveStats.err = (when - expected) * 1000;
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
