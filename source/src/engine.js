// 播放引擎：解码/合成音频、把“控制端时钟”换算成 AudioContext 时间、精确调度、漂移修正
import { synthBuffer } from './synth.js';

const DRIFT_LIMIT_MS = 35;
const START_LEAD_MS = 150;

export class Engine extends EventTarget {
  constructor(clock, { fetchFile } = {}) {
    super();
    this.clock = clock; // { now(): 控制端时钟毫秒, synced: bool }
    this.fetchFile = fetchFile; // (id) => Promise<ArrayBuffer>，从控制端拉取文件
    this.liveIn = null; this.liveVoices = []; this.liveSig = null; this.liveCursor = null;
    this.liveStats = { got: 0, late: 0, resyncs: 0, err: null };
    this.liveSources = new Set();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.deviceGain = this.ctx.createGain();
    this.deviceGain.connect(this.master);
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
      if (document.visibilityState === 'visible') {
        if (this.unlocked) this.ctx.resume().catch(() => {});
        this.sig = null;
        this.apply();
      }
    });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async unlock() { // 必须在点击事件里调用
    await this.ctx.resume();
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.ctx.destination); s.start();
    this.unlocked = true;
    this.sig = null;
    this.apply();
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
      v.src.start(ctxT, Math.max(0, off));
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
    const sig = JSON.stringify(plan.sources.map((s) => [s.mix.type, s.mix.index, s.filters.map((f) => f.type)]));
    if (sig === this.liveSig && this.liveIn) return;
    this.teardownLive();
    this.liveSig = sig;
    this.liveIn = this.ctx.createGain();
    this.liveIn.channelCount = 2; this.liveIn.channelCountMode = 'explicit';
    this.liveVoices = plan.sources.map((s, idx) => Object.assign(this.buildChain(this.liveIn, 2, s), { idx }));
  }
  teardownLive() {
    if (!this.liveIn) return;
    for (const src of this.liveSources) { try { src.stop(); } catch {} }
    this.liveSources.clear();
    try { this.liveIn.disconnect(); } catch {}
    for (const v of this.liveVoices) { try { v.out.disconnect(); } catch {} v.nodes.forEach((n) => { try { n.disconnect(); } catch {} }); }
    this.liveIn = null; this.liveVoices = []; this.liveSig = null; this.liveCursor = null;
  }
  // 收到一段实时音频：在“采集时刻 + 统一缓冲延迟 + 本机延迟”播出
  pushLive(ts, buffer) {
    const cur = this.cur;
    if (!this.unlocked || !this.clock.synced || !cur?.plan || cur.group?.kind !== 'live' || !this.liveIn) return;
    this.liveStats.got++;
    const expected = this.clockToCtx(ts + (cur.ld || 350) + cur.plan.D);
    const now = this.ctx.currentTime;
    if (expected + buffer.duration < now + 0.005) { this.liveStats.late++; return; } // 来得太晚，丢掉
    let when, rate = 1;
    if (this.liveCursor === null || Math.abs(this.liveCursor - expected) > 0.04) {
      when = Math.max(expected, now + 0.005);
      this.liveStats.resyncs++;
    } else {
      // 紧接上一段播放（无缝），并用极小的变速慢慢追平时钟误差（最多 0.3%，听不出来）
      when = this.liveCursor;
      const err = this.liveCursor - expected;
      rate = 1 + Math.max(-0.003, Math.min(0.003, err * 2));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.liveIn);
    src.start(when);
    src.onended = () => { this.liveSources.delete(src); try { src.disconnect(); } catch {} };
    this.liveSources.add(src);
    this.liveCursor = when + buffer.duration / rate;
    this.liveStats.err = (when - expected) * 1000;
  }

  updateParams(plan) {
    const t = this.ctx.currentTime;
    this.deviceGain.gain.setTargetAtTime(plan.gain, t, 0.04);
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
    this.stopAll();
    this.teardownLive();
    this.ctx.close();
  }
}
