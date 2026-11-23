// SoundMesh 独立网页版：控制端 + 播放节点；设备之间 WebRTC 直连；支持电脑实时音源
import { computeMix, assignLabel, assignOptions, guessRole } from './mix.js';
import { Engine } from './engine.js';
import { BUILTIN_GROUPS } from './synth.js';
import { HostLink, NodeLink, packBin } from './transport.js';
import { LiveCapture, LiveDecoder, opusDecodeSupported, pcmEncode } from './live.js';

// ---------------- 小工具 ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const hostNow = () => performance.timeOrigin + performance.now();
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 3500);
}
function ask(msg, { input = null } = {}) {
  return new Promise((ok) => {
    $('#modalMsg').textContent = msg;
    const inp = $('#modalInput');
    inp.hidden = input === null; inp.value = input ?? '';
    $('#modal').hidden = false;
    if (input !== null) setTimeout(() => inp.focus(), 50);
    const done = (v) => { $('#modal').hidden = true; ok(v); };
    $('#modalOk').onclick = () => done(input === null ? true : inp.value);
    $('#modalCancel').onclick = () => done(input === null ? false : null);
  });
}
function detectDeviceType() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'phone';
  return 'computer';
}
const TYPE_ICON = { phone: '📱', tablet: '📟', computer: '💻' };
const TYPE_NAME = { phone: '手机', tablet: '平板', computer: '电脑' };
const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#20c997', '#f06595', '#94d82d', '#748ffc'];
const PB_CODE = { stopped: 0, playing: 1, paused: 2 }, PB_NAME = ['stopped', 'playing', 'paused'];
const LIVE_GROUP = {
  id: 'live', name: '电脑实时音源（YouTube / Spotify…）', kind: 'live', loop: false, duration: 0,
  tracks: [{ id: 'live', name: '实时音频', src: 'live', channels: 2, duration: 0, role: 'other' }],
};
const pageUrl = () => location.origin + location.pathname + (new URLSearchParams(location.search).get('peer') ? `?peer=${new URLSearchParams(location.search).get('peer')}&` : '?');

// 音频文件存在浏览器的 IndexedDB 里，刷新后还在
const idb = {
  db: null,
  open() {
    if (this.db) return this.db;
    this.db = new Promise((ok, bad) => {
      const r = indexedDB.open('soundmesh', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
    });
    return this.db;
  },
  async op(mode, fn) {
    const db = await this.open();
    return new Promise((ok, bad) => {
      const tx = db.transaction('files', mode), req = fn(tx.objectStore('files'));
      tx.oncomplete = () => ok(req?.result); tx.onerror = () => bad(tx.error);
    });
  },
  put(k, v) { return this.op('readwrite', (s) => s.put(v, k)).catch(() => {}); },
  get(k) { return this.op('readonly', (s) => s.get(k)).catch(() => undefined); },
  del(k) { return this.op('readwrite', (s) => s.delete(k)).catch(() => {}); },
};

// ---------------- 首页 ----------------
const params = new URLSearchParams(location.search);
const joinParam = (params.get('join') || '').toUpperCase();
const last = store.get('sm-host-state', null);
if (last?.code) $('#recent').innerHTML = `<a href="#" id="resume">回到上次的房间 ${esc(last.code)}</a>（设备位置和曲目都保留）`;
$('#resume')?.addEventListener('click', (e) => { e.preventDefault(); startHost(last.code, true); });
$('#create').onclick = () => startHost(newCode(), false);
const doJoin = () => {
  const id = $('#code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(id)) return ($('#err').textContent = '请输入 6 位房间码');
  startNode(id);
};
$('#join').onclick = doJoin;
$('#code').onkeydown = (e) => e.key === 'Enter' && doJoin();
if (!window.Peer) $('#libErr').hidden = false;
if (joinParam) { $('#code').value = joinParam; startNode(joinParam); }

// =====================================================================
//                               控制端
// =====================================================================
const EPOCH = rid(6);
let H = null;

function defaultHostState(code) {
  return {
    code, size: { w: 8, h: 5 }, listener: { x: 4, y: 3.5 }, devices: {},
    mode: 'sync', gainPreset: 'balanced', options: { distanceGain: true, distanceDelay: true, stereo: true },
    stereoWidth: 1, splitPreset: 'auto', bands: { lowCut: 150, highCut: 2500 }, masterVolume: 1,
    library: [], currentGroupId: 'demo-mix', liveDelay: 350, autoDelay: true, opus: true,
    playback: { status: 'stopped', startServerTime: 0, startOffset: 0 }, colorIdx: 0,
  };
}

function startHost(code, resume) {
  const saved = store.get('sm-host-state', null);
  H = saved ? { ...defaultHostState(code), ...saved, code } : defaultHostState(code);
  H.library = [structuredClone(LIVE_GROUP), ...structuredClone(BUILTIN_GROUPS), ...(H.library || []).filter((g) => g.kind === 'file')];
  if (!H.library.some((g) => g.id === H.currentGroupId) || H.currentGroupId === 'live') H.currentGroupId = 'demo-mix';
  H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 };
  if (!saved?.v2) { H.liveDelay = 350; H.autoDelay = true; H.v2 = true; } // 旧版本默认 800ms 太保守
  for (const d of Object.values(H.devices)) d.online = false;
  delete H.devices.self;
  $('#landing').hidden = true;
  $('#hostView').hidden = false;
  host.init(code, resume);
}

const host = {
  link: null, selfEngine: null, lastWire: '', pubTimer: null, selected: null, files: new Map(), sending: new Set(),
  live: new LiveCapture(hostNow),

  init(code, resume) {
    this.setCode(code);
    this.bindUI();
    this.render();
    if (!window.Peer) return this.status('连接库没加载出来，检查网络后刷新', 'bad');
    this.link = new HostLink(code);
    let tries = 0;
    this.link.addEventListener('status', (e) => {
      const s = e.detail;
      if (s === 'open') this.status('已上线', 'ok');
      else if (s === 'signal-lost') this.status('信令服务器断开，重连中（已连上的设备不受影响）', 'warn');
      else if (s === 'taken') {
        // 刚刷新时旧连接可能还没释放，等一下再试；还不行就换个房间码
        if (resume && tries++ < 4) { this.status('房间码被占用，重试中…', 'warn'); setTimeout(() => this.link.restartWithCode(H.code), 3000); }
        else { const c = newCode(); this.setCode(c); this.link.restartWithCode(c); }
      } else this.status('连接问题：' + s.replace('error:', '') + '（检查网络）', 'bad');
    });
    this.link.addEventListener('msg', (e) => this.onMsg(e.detail));
    this.link.addEventListener('peers', () => this.onPeers());
    this.live.addEventListener('chunk', (e) => this.onLiveChunk(e.detail));
    this.live.addEventListener('opus', (e) => this.onLiveOpus(e.detail));
    this.live.addEventListener('state', (e) => this.onLiveState(e.detail));
    setInterval(() => this.tick(), 500);
    window.smHost = this; // 调试用
  },

  setCode(code) {
    H.code = code;
    $('#hCode').textContent = code;
    const url = `${pageUrl()}join=${code}`;
    $('#joinUrl').textContent = url;
    if (location.protocol === 'file:') { // 本地文件打开：手机访问不到，直接提示
      $('#qrBox').innerHTML = '';
      $('#joinUrl').textContent = '⚠️ 现在是直接打开的本地文件，手机访问不到。请先把 index.html 部署到 GitHub Pages / Netlify，再用那个 https 网址打开。';
      $('#joinUrl').style.whiteSpace = 'normal'; $('#joinUrl').style.color = 'var(--warn)';
      this.changed();
      return;
    }
    if (window.qrcode) {
      const q = window.qrcode(0, 'M'); q.addData(url); q.make();
      $('#qrBox').innerHTML = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    }
    $('#copy').onclick = () => navigator.clipboard?.writeText(url).then(() => toast('已复制'), () => toast('复制失败，请手动选择链接'));
    this.changed();
  },
  status(t, cls) { $('#hConn').textContent = t; $('#hConn').className = 'badge ' + cls; },

  onMsg({ client: c, msg }) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      const did = c.did;
      if (!did) return;
      c.opus = !!msg.opus;
      let d = H.devices[did];
      if (!d) {
        const n = Object.keys(H.devices).length;
        d = H.devices[did] = {
          id: did, name: String(msg.name || `设备 ${n + 1}`).slice(0, 24), type: TYPE_NAME[msg.type] ? msg.type : 'computer',
          color: COLORS[H.colorIdx++ % COLORS.length], ...arcSpot(n),
          volume: 1, muted: false, latencyMs: 0, caps: { bass: false },
          override: { locked: false, assign: [], gain: null, delayMs: null, pan: null },
        };
      }
      d.stats = {};
      this.onPeers();
      this.lastWire = ''; // 新设备：马上发一次完整状态
      this.publish();
    } else if (msg.t === 'ping') {
      this.link.send(c, { t: 'pong', c: msg.c, s: hostNow(), ep: EPOCH });
    } else if (msg.t === 'stats' && H.devices[c.did]) {
      const prevLate = H.devices[c.did].stats?.live?.late;
      H.devices[c.did].stats = msg.stats || {};
      // 自动调节：某台设备的音频分段开始“迟到”（来不及播），就把缓冲加大一点
      const late = msg.stats?.live?.late;
      if (H.autoDelay && this.live.running && Number.isFinite(late) && Number.isFinite(prevLate) && late > prevLate + 2 && H.liveDelay < 1500) {
        H.liveDelay = Math.min(1500, H.liveDelay + 50);
        toast(`${H.devices[c.did].name} 有卡顿，缓冲自动加到 ${H.liveDelay} ms`);
        this.changed();
      }
      this.renderSoon();
    } else if (msg.t === 'self' && H.devices[c.did]) {
      const d = H.devices[c.did];
      if (typeof msg.name === 'string' && msg.name.trim()) d.name = msg.name.trim().slice(0, 24);
      if (Number.isFinite(msg.latencyMs)) d.latencyMs = Math.max(-1000, Math.min(1000, msg.latencyMs));
      this.changed();
    } else if (msg.t === 'getFile') this.sendFile(c, String(msg.id));
  },

  onPeers() {
    const online = new Set([...this.link.clients.values()].filter((c) => c.did && c.ctl?.open).map((c) => c.did));
    for (const d of Object.values(H.devices)) if (d.id !== 'self') d.online = online.has(d.id);
    this.updateOpusWant();
    this.changed();
  },

  // ---------- 文件分发 ----------
  async getFile(id) {
    if (this.files.has(id)) return this.files.get(id);
    const buf = await idb.get('f:' + id);
    if (buf) this.files.set(id, buf);
    return buf;
  },
  async sendFile(c, id) {
    const key = c.did + '|' + id;
    if (this.sending.has(key)) return;
    this.sending.add(key);
    try {
      const buf = await this.getFile(id);
      if (!buf) { this.link.send(c, { t: 'fileErr', id }); return; }
      const total = buf.byteLength, CH = 16000;
      for (let off = 0; off < total; off += CH) {
        while (this.link.buffered(c) > 1 << 20) { await sleep(20); if (!c.bin?.open) return; }
        if (!this.link.sendBin(c, packBin({ k: 'f', id, off, total }, new Uint8Array(buf, off, Math.min(CH, total - off))))) return;
      }
    } finally { this.sending.delete(key); }
  },

  // ---------- 实时音源 ----------
  updateOpusWant() {
    const clients = [...this.link?.clients.values() || []].filter((c) => c.did);
    this.live.wantOpus = H.opus && clients.some((c) => c.opus);
  },
  onLiveChunk({ ts, l, r }) {
    if (H.currentGroupId !== 'live') return;
    if (this.selfEngine) {
      const ctx = this.selfEngine.ctx, buf = ctx.createBuffer(2, l.length, 48000);
      buf.copyToChannel(l, 0); buf.copyToChannel(r, 1);
      this.selfEngine.pushLive(ts, buf);
    }
    let pcm = null;
    for (const c of this.link?.clients.values() || []) {
      if (!c.did || (c.opus && this.live.wantOpus)) continue;
      if (this.link.buffered(c) > 512 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; } // 网络跟不上：丢这一段
      pcm = pcm || pcmEncode(l, r);
      this.link.sendBin(c, packBin({ k: 'l', ts, c: 'p', sr: 48000 }, pcm));
    }
  },
  onLiveOpus({ ts, data }) {
    if (H.currentGroupId !== 'live') return;
    for (const c of this.link?.clients.values() || []) {
      if (!c.did || !c.opus) continue;
      if (this.link.buffered(c) > 512 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; }
      this.link.sendBin(c, packBin({ k: 'l', ts, c: 'o' }, data));
    }
  },
  onLiveState(on) {
    if (on) { H.currentGroupId = 'live'; H.playback = { status: 'playing', startServerTime: hostNow(), startOffset: 0 }; }
    else if (H.currentGroupId === 'live') H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 };
    this.updateOpusWant();
    this.libSig = null;
    this.changed();
  },
  async toggleLive() {
    if (this.live.running) return this.live.stop();
    // 必须在这次点击里先启用本机声音（浏览器要求声音由点击触发）；
    // 共享的是标签页时电脑原声会被静音，电脑就改为和手机一起同步出声
    const autoSelf = !this.selfEngine;
    if (autoSelf) this.toggleSelf();
    try {
      await this.live.startCapture();
      if (this.live.surface !== 'browser' && this.selfEngine) {
        // 共享窗口/整个屏幕时抓的是系统声音：电脑原声不会被静音，本机再出声还会被重新抓进去形成回声
        this.toggleSelf();
        toast('你共享的是窗口/整个屏幕：电脑会保留原声，手机比电脑晚一点。想让电脑和手机完全同步，请改为共享 Chrome 标签页');
      }
    } catch (e) {
      if (autoSelf && this.selfEngine) this.toggleSelf();
      if (e.name !== 'NotAllowedError') toast(e.message || String(e));
    }
  },

  changed() {
    this.render();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const { devices, library, ...rest } = H;
      const devs = Object.fromEntries(Object.entries(devices).filter(([k]) => k !== 'self').map(([k, d]) => [k, { ...d, stats: {}, online: false }]));
      store.set('sm-host-state', { ...rest, devices: devs, library: library.filter((g) => g.kind === 'file') });
    }, 500);
    if (this.pubTimer) return;
    this.pubTimer = setTimeout(() => { this.pubTimer = null; this.publish(); }, 80);
  },
  renderSoon() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 300);
  },

  plans() { return computeMix(H); },
  group() { return H.library.find((g) => g.id === H.currentGroupId); },

  wire(plans) {
    const g = this.group(), pb = H.playback;
    const w = {
      v: 1, ep: EPOCH, ld: H.liveDelay, pb: [PB_CODE[pb.status], Math.round(pb.startServerTime), r3(pb.startOffset)], m: H.mode === 'split' ? 1 : 0,
      g: g ? { id: g.id, k: g.kind, n: g.name.slice(0, 60), l: g.loop ? 1 : 0, d: r3(g.duration || 0), t: g.tracks.map((t) => [t.src, t.channels]) } : null,
      p: {},
    };
    for (const [did, pl] of Object.entries(plans)) {
      const d = H.devices[did];
      const idx = (id) => g.tracks.findIndex((t) => t.id === id);
      w.p[did] = [r3(pl.gain), r1(pl.delayMs), d.latencyMs,
        pl.sources.map((s) => [idx(s.trackId), s.mix.type === 'lr' ? ['l', r3(s.mix.wl), r3(s.mix.wr)] : s.mix.type === 'ch' ? ['c', s.mix.index] : ['s'], s.filters.map((f) => [f.type[0], Math.round(f.freq)])]),
        (H.mode === 'split' ? pl.assign.map((k) => assignLabel(H, k)).join(' + ') : '协同播放').slice(0, 60), d.color, d.name];
    }
    return w;
  },

  publish() {
    const w = this.wire(this.plans());
    if (this.selfEngine) this.selfEngine.update(decodeWire(w, 'self'));
    const s = JSON.stringify(w);
    if (s === this.lastWire || !this.link) return;
    this.lastWire = s;
    this.link.broadcast({ t: 'state', st: w });
  },

  tick() {
    const g = this.group();
    if (H.playback.status === 'playing' && g && g.kind !== 'live' && !g.loop && this.position() > g.duration + 0.5) {
      H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 };
      this.changed();
    }
    if (Date.now() - (this.lastFull || 0) > 3000) { this.lastFull = Date.now(); this.lastWire = ''; this.publish(); } // 定期重发，防丢
    this.renderTime();
    this.renderLive();
  },
  position() {
    const pb = H.playback;
    if (pb.status !== 'playing') return pb.startOffset;
    return Math.max(pb.startOffset, pb.startOffset + (hostNow() - pb.startServerTime) / 1000);
  },
  play(offset) {
    const g = this.group(); if (!g || g.kind === 'live') return;
    let start = offset ?? (H.playback.status === 'paused' ? H.playback.startOffset : 0);
    if (!g.loop && start >= g.duration) start = 0;
    H.playback = { status: 'playing', startServerTime: hostNow() + 900, startOffset: Math.max(0, start) };
    this.changed();
  },
  pause() {
    if (H.playback.status !== 'playing' || this.group()?.kind === 'live') return;
    H.playback = { status: 'paused', startServerTime: 0, startOffset: this.position() };
    this.changed();
  },
  seek(o) {
    if (H.playback.status === 'playing') this.play(o);
    else { H.playback = { status: 'paused', startServerTime: 0, startOffset: o }; this.changed(); }
  },
  selectGroup(id) {
    if (id === H.currentGroupId) return;
    if (this.live.running && id !== 'live') this.live.stop();
    H.currentGroupId = id;
    H.playback = id === 'live' && this.live.running ? { status: 'playing', startServerTime: hostNow(), startOffset: 0 } : { status: 'stopped', startServerTime: 0, startOffset: 0 };
    this.changed();
  },

  bindUI() {
    $('#play').onclick = () => this.play();
    $('#pause').onclick = () => this.pause();
    $('#stop').onclick = () => { H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 }; this.changed(); };
    $('#seek').oninput = () => (this.seeking = true);
    $('#seek').onchange = (e) => { this.seeking = false; this.seek(Number(e.target.value)); };
    $('#master').oninput = (e) => { H.masterVolume = Number(e.target.value); this.changed(); };
    $('#liveBtn').onclick = () => this.toggleLive();
    $('#liveDelay').oninput = (e) => { H.liveDelay = Number(e.target.value); this.changed(); };
    $('#autoDelay').onchange = (e) => { H.autoDelay = e.target.checked; this.changed(); };
    $('#opusOn').onchange = (e) => { H.opus = e.target.checked; this.updateOpusWant(); this.changed(); };
    $$('#modeSeg button').forEach((b) => (b.onclick = () => { H.mode = b.dataset.mode; this.changed(); }));
    $$('[data-opt]').forEach((c) => (c.onchange = () => { H.options[c.dataset.opt] = c.checked; this.changed(); }));
    $('#gainPreset').onchange = (e) => { H.gainPreset = e.target.value; this.changed(); };
    $('#splitPreset').onchange = (e) => { H.splitPreset = e.target.value; this.changed(); };
    $('#width').oninput = (e) => { H.stereoWidth = Number(e.target.value); this.changed(); };
    const clampN = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
    const bands = () => { H.bands = { lowCut: clampN($('#lowCut').value, 40, 1000, 150), highCut: clampN($('#highCut').value, 500, 12000, 2500) }; this.changed(); };
    $('#lowCut').onchange = bands; $('#highCut').onchange = bands;
    const size = () => {
      H.size = { w: clampN($('#roomW').value, 1, 50, 8), h: clampN($('#roomH').value, 1, 50, 5) };
      for (const o of [H.listener, ...Object.values(H.devices)]) { o.x = Math.min(o.x, H.size.w); o.y = Math.min(o.y, H.size.h); }
      this.changed();
    };
    $('#roomW').onchange = size; $('#roomH').onchange = size;
    $('#arc').onclick = () => { Object.values(H.devices).filter((d) => d.online).forEach((d, i) => Object.assign(d, arcSpot(i))); this.changed(); };
    $('#upload').onclick = () => this.addAudio();
    $('#selfNode').onclick = () => this.toggleSelf();
    this.bindCanvas();
  },

  async toggleSelf() {
    if (!this.selfEngine && this.live.running && this.live.surface !== 'browser') {
      return toast('正在共享窗口/整个屏幕：本机再出声会被重新抓进去形成回声，所以不能开。改为共享标签页就可以');
    }
    if (this.selfEngine) {
      this.selfEngine.destroy(); this.selfEngine = null;
      delete H.devices.self;
      $('#selfNode').textContent = '🔈 本机也出声';
      return this.changed();
    }
    this.selfEngine = new Engine({ now: hostNow, synced: true }, { fetchFile: async (id) => { const b = await this.getFile(id); if (!b) throw new Error('文件丢失'); return b; } });
    this.selfEngine.unlock().catch(() => toast('无法启用声音'));
    this.selfEngine.addEventListener('status', () => this.renderSoon());
    H.devices.self = {
      id: 'self', name: '控制端本机', type: detectDeviceType(), color: '#e9ecef', ...arcSpot(Object.keys(H.devices).length),
      volume: 1, muted: false, latencyMs: 0, caps: { bass: detectDeviceType() === 'computer' }, online: true,
      override: { locked: false, assign: [], gain: null, delayMs: null, pan: null }, stats: {},
    };
    $('#selfNode').textContent = '🔇 本机不出声';
    this.changed();
  },

  async addAudio() {
    const files = [...$('#files').files];
    if (!files.length) return toast('先选择音频文件');
    if (files.length > 8) return toast('一组最多 8 条分轨');
    const msg = (t) => ($('#upMsg').innerHTML = t);
    $('#upload').disabled = true;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const tracks = [];
      for (const [i, f] of files.entries()) {
        msg(`分析 ${i + 1}/${files.length}：${esc(f.name)}`);
        const data = await f.arrayBuffer();
        let audio;
        try { audio = await ctx.decodeAudioData(data.slice(0)); } catch { throw new Error(`${f.name} 无法解码，换成 MP3/WAV/M4A 试试`); }
        const id = rid(10);
        this.files.set(id, data);
        await idb.put('f:' + id, data);
        const name = f.name.replace(/\.[^.]+$/, '');
        tracks.push({ id: rid(5), name: name.slice(0, 40), src: 'file:' + id, channels: audio.numberOfChannels, duration: audio.duration, role: guessRole(name) });
      }
      const name = ($('#groupName').value.trim() || (files.length > 1 ? '分轨组 ' + tracks[0].name : tracks[0].name)).slice(0, 40);
      const g = { id: rid(6), name, kind: 'file', loop: false, tracks, duration: Math.max(...tracks.map((t) => t.duration)) };
      H.library.push(g);
      if (H.playback.status !== 'playing') this.selectGroup(g.id);
      msg(`✅ 已添加：${esc(name)}。选中后，各设备会自动从本机下载。`);
      $('#files').value = ''; $('#groupName').value = '';
      this.libSig = null;
      this.changed();
    } catch (e) { msg('❌ ' + esc(e.message)); } finally { $('#upload').disabled = false; ctx.close(); }
  },

  // ---------- 画布 ----------
  bindCanvas() {
    const svg = $('#canvas');
    const pt = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest('[data-drag]');
      if (!g) return;
      const p = pt(e), obj = g.dataset.drag === 'listener' ? H.listener : H.devices[g.dataset.id];
      if (!obj) return;
      this.drag = { obj, dx: obj.x * 100 - p.x, dy: obj.y * 100 - p.y };
      svg.setPointerCapture(e.pointerId);
      if (g.dataset.drag === 'dev') this.select(g.dataset.id);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = pt(e);
      this.drag.obj.x = Math.min(H.size.w, Math.max(0, (p.x + this.drag.dx) / 100));
      this.drag.obj.y = Math.min(H.size.h, Math.max(0, (p.y + this.drag.dy) / 100));
      this.changed();
    });
    const end = () => (this.drag = null);
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  },
  select(id) {
    this.selected = id;
    this.render();
    this.cards.get(id)?.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  render() {
    if (!H) return;
    const plans = this.plans();
    this.renderCanvas(plans);
    this.renderLibrary();
    this.renderRules();
    this.renderDevices(plans);
    this.renderTime();
    this.renderLive();
  },

  renderTime() {
    const g = this.group(), isLive = g?.kind === 'live';
    $('#fileTransport').hidden = isLive;
    $('#livePanel').hidden = !isLive;
    if (isLive) return;
    const pos = this.position(), dur = g?.duration || 0;
    $('#time').textContent = g?.loop ? `循环 · ${fmt(pos % (dur || 1))}` : `${fmt(Math.min(pos, dur))} / ${fmt(dur)}`;
    if (!this.seeking && document.activeElement !== $('#seek')) { $('#seek').max = dur || 0; $('#seek').value = g?.loop ? pos % (dur || 1) : pos; }
  },

  renderLive() {
    if ($('#livePanel').hidden) return;
    const on = this.live.running;
    $('#liveBtn').textContent = on ? '■ 停止共享' : '🎙 开始共享电脑声音';
    $('#liveBtn').className = on ? 'danger' : 'primary';
    $('#liveLevel').style.width = `${Math.min(100, this.live.stats.level * 100)}%`;
    if (document.activeElement !== $('#liveDelay')) $('#liveDelay').value = H.liveDelay;
    $('#liveDelayVal').textContent = `${H.liveDelay} ms`;
    $('#opusOn').checked = H.opus;
    $('#autoDelay').checked = H.autoDelay;
    const clients = [...this.link?.clients.values() || []].filter((c) => c.did);
    const opusN = clients.filter((c) => c.opus && this.live.wantOpus).length;
    const dropped = clients.reduce((a, c) => a + (c.dropped || 0), 0);
    const surf = { browser: '标签页 ✅', window: '窗口 ⚠️', monitor: '整个屏幕 ⚠️' }[this.live.surface] || '未知';
    $('#liveStatus').textContent = on
      ? `共享类型：${surf}${this.live.surface !== 'browser' ? '（电脑原声不会静音，手机会比电脑晚）' : ''} · 正在采集 · 已发送 ${this.live.stats.chunks} 段 · ${opusN} 台用 Opus 压缩、${clients.length - opusN} 台用无损 PCM${dropped ? ` · 网络丢弃 ${dropped} 段` : ''}`
      : '未在共享';
  },

  renderCanvas(plans) {
    const svg = $('#canvas'), NS = 'http://www.w3.org/2000/svg', U = 100;
    const el = (tag, attrs = {}, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const { w, h } = H.size, pad = 40;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${w * U + pad * 2} ${h * U + pad * 2}`);
    svg.replaceChildren();
    svg.append(el('rect', { class: 'room', x: 0, y: 0, width: w * U, height: h * U, rx: 8 }));
    const grid = el('g', { class: 'grid' });
    for (let x = 1; x < w; x++) grid.append(el('line', { x1: x * U, y1: 0, x2: x * U, y2: h * U }));
    for (let y = 1; y < h; y++) grid.append(el('line', { x1: 0, y1: y * U, x2: w * U, y2: y * U }));
    svg.append(grid);
    svg.append(el('text', { x: (w * U) / 2, y: -14, 'text-anchor': 'middle', class: 'sub' }, `▲ 前方 / 舞台   （网格 1 米，房间 ${w}×${h} 米）`));
    const L = H.listener, devs = Object.values(H.devices);
    for (const d of devs) if (d.online) svg.append(el('line', { class: 'link', x1: L.x * U, y1: L.y * U, x2: d.x * U, y2: d.y * U }));
    const lg = el('g', { class: 'listener', 'data-drag': 'listener', transform: `translate(${L.x * U},${L.y * U})` });
    lg.append(el('circle', { r: 30, fill: '#ffd43b22', stroke: '#ffd43b', 'stroke-width': 2 }));
    lg.append(el('text', { 'text-anchor': 'middle', y: 9, style: 'font-size:26px' }, '👑'));
    lg.append(el('text', { 'text-anchor': 'middle', y: 50, class: 'sub' }, '听众位'));
    svg.append(lg);
    for (const d of devs) {
      const plan = plans[d.id], r = 28;
      const g = el('g', { class: `dev ${d.online ? '' : 'offline'} ${this.selected === d.id ? 'selected' : ''}`, 'data-drag': 'dev', 'data-id': d.id, transform: `translate(${d.x * U},${d.y * U})` });
      g.append(el('circle', { class: 'ring', r: r + 6 }));
      if (plan) g.append(el('circle', { r: r + 2 + plan.gain * 14, fill: d.color + '22', stroke: 'none' }));
      g.append(el('circle', { class: 'body', r, fill: d.color, stroke: '#0008', 'stroke-width': 2 }));
      g.append(el('text', { 'text-anchor': 'middle', y: 9, style: 'font-size:24px' }, d.muted ? '🔇' : TYPE_ICON[d.type]));
      g.append(el('text', { 'text-anchor': 'middle', y: r + 22 }, d.name));
      let sub = d.online ? '' : '离线';
      if (plan) {
        const parts = [`${Math.round(plan.gain * 100)}%`];
        const D = plan.delayMs + d.latencyMs;
        if (Math.abs(D) >= 0.05) parts.push(`${D > 0 ? '+' : ''}${D.toFixed(1)}ms`);
        if (H.mode === 'split') {
          const a = plan.assign.map((k) => assignLabel(H, k).replace(/^声道 /, '')).join('+') || '无';
          parts.push(a.length > 18 ? a.slice(0, 17) + '…' : a);
        } else if (H.options.stereo) parts.push(plan.pan < -0.2 ? '偏左' : plan.pan > 0.2 ? '偏右' : '居中');
        if (d.override?.locked) parts.push('🔒');
        sub = parts.join(' · ');
      }
      g.append(el('text', { 'text-anchor': 'middle', y: r + 40, class: 'sub' }, sub));
      svg.append(g);
    }
  },

  renderLibrary() {
    const icon = (g) => (g.kind === 'live' ? (this.live.running ? '🔴' : '🎙️') : g.id === 'click' ? '🥁' : g.tracks.length > 1 ? '🎚️' : g.tracks[0]?.channels > 2 ? '🔈' : '🎵');
    const sig = JSON.stringify([H.library.map((g) => [g.id, g.name]), H.currentGroupId, this.live.running]);
    if (sig === this.libSig) return;
    this.libSig = sig;
    $('#library').innerHTML = H.library.map((g) => `
      <div class="lib-item ${g.id === H.currentGroupId ? 'active' : ''}" data-id="${esc(g.id)}">
        <span>${icon(g)}</span>
        <span class="name">${esc(g.name)}</span>
        <span class="muted small">${g.kind === 'live' ? '实时' : g.tracks.length > 1 ? `${g.tracks.length} 轨` : g.tracks[0]?.channels > 2 ? `${g.tracks[0].channels} 声道` : g.loop ? '循环' : fmt(g.duration)}</span>
        ${g.kind === 'file' ? `<button class="small danger" data-del="${esc(g.id)}">✕</button>` : ''}
      </div>`).join('');
    $$('#library .lib-item').forEach((it) => (it.onclick = async (e) => {
      const del = e.target.dataset.del;
      if (del) {
        if (!(await ask('删除这个曲目？'))) return;
        const g = H.library.find((x) => x.id === del);
        g?.tracks.forEach((t) => { const id = t.src.slice(5); this.files.delete(id); idb.del('f:' + id); });
        H.library = H.library.filter((x) => x.id !== del);
        if (H.currentGroupId === del) this.selectGroup('demo-mix');
        return this.changed();
      }
      this.selectGroup(it.dataset.id);
    }));
  },

  renderRules() {
    const setVal = (sel, v, prop = 'value') => { const e = $(sel); if (e && document.activeElement !== e) e[prop] = v; };
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === H.mode));
    $$('[data-opt]').forEach((c) => { if (document.activeElement !== c) c.checked = !!H.options[c.dataset.opt]; });
    setVal('#gainPreset', H.gainPreset); setVal('#splitPreset', H.splitPreset); setVal('#width', H.stereoWidth);
    setVal('#lowCut', H.bands.lowCut); setVal('#highCut', H.bands.highCut);
    setVal('#roomW', H.size.w); setVal('#roomH', H.size.h); setVal('#master', H.masterVolume);
    $('#masterVal').textContent = Math.round(H.masterVolume * 100) + '%';
    $('#splitBox').style.display = H.mode === 'split' ? '' : 'none';
  },

  cards: new Map(),
  renderDevices(plans) {
    const devs = Object.values(H.devices).sort((a, b) => b.online - a.online);
    const box = $('#devices');
    for (const [id, c] of this.cards) if (!H.devices[id]) { c.root.remove(); this.cards.delete(id); }
    devs.forEach((d, i) => {
      let c = this.cards.get(d.id);
      if (!c) { c = this.buildCard(d.id); this.cards.set(d.id, c); }
      if (box.children[i] !== c.root) box.insertBefore(c.root, box.children[i] || null);
      this.updateCard(c, d, plans[d.id]);
    });
    const online = devs.filter((d) => d.online);
    $('#devCount').textContent = `${online.length} 在线`;
    $('#noDev').style.display = devs.length ? 'none' : '';
    const ready = online.filter((d) => (d.id === 'self' ? this.selfEngine?.loadInfo.loaded === this.selfEngine?.loadInfo.needed : d.stats?.ready && d.stats?.unlocked && d.stats?.synced)).length;
    $('#ready').textContent = online.length ? `${ready}/${online.length} 台设备已就绪${ready < online.length ? '（没就绪的设备准备好后会自动跟上）' : ''}` : '';
  },

  buildCard(id) {
    const root = document.createElement('div');
    root.className = 'card dev-card';
    root.innerHTML = `
      <div class="head"><span data-f="icon"></span><input type="text" data-f="name" maxlength="24" /><span data-f="online" class="badge"></span></div>
      <div class="row small" data-f="badges" style="margin-top:4px"></div>
      <div class="small muted" data-f="stats" style="margin-top:6px"></div>
      <div class="small" data-f="plan" style="margin-top:4px"></div>
      <div class="ctrl">
        <span>音量</span><input type="range" data-f="volume" min="0" max="1.5" step="0.01" /><span data-f="volVal"></span>
        <span>延迟微调</span><input type="range" data-f="lat" min="-500" max="500" step="5" /><input type="number" data-f="latNum" min="-1000" max="1000" step="1" />
      </div>
      <div class="row small" style="margin-top:8px">
        <label><input type="checkbox" data-f="muted" /> 静音</label>
        <label title="分工时优先分配低频/贝斯/LFE"><input type="checkbox" data-f="bass" /> 低音强</label>
        <span class="grow"></span>
        <button class="small" data-f="beep">🔔 响一下</button>
        <button class="small danger" data-f="remove">移除</button>
      </div>
      <details>
        <summary>手动覆盖规则</summary>
        <div class="stack" style="margin-top:8px">
          <label><input type="checkbox" data-f="locked" /> 🔒 锁定声音分工（使用下面的手动绑定）</label>
          <div data-f="assignBox"></div>
          <div class="ctrl" style="margin-top:0">
            <label><input type="checkbox" data-f="gOn" />增益</label><input type="range" data-f="gain" min="0" max="1.5" step="0.01" /><span data-f="gainVal"></span>
            <label><input type="checkbox" data-f="dOn" />延迟</label><input type="range" data-f="delay" min="0" max="200" step="0.5" /><span data-f="delayVal"></span>
            <label><input type="checkbox" data-f="pOn" />声相</label><input type="range" data-f="pan" min="-1" max="1" step="0.05" /><span data-f="panVal"></span>
          </div>
          <div class="muted small">不勾选 = 用自动计算的值。这里的延迟是“位置补偿”部分，上面的延迟微调另外叠加。</div>
        </div>
      </details>`;
    const f = (n) => root.querySelector(`[data-f="${n}"]`);
    const dev = () => H.devices[id];
    const set = (patch) => { if (dev()) { Object.assign(dev(), patch); this.changed(); } };
    const setOv = (patch) => set({ override: { ...dev().override, ...patch } });
    const plan = () => this.plans()[id];
    root.addEventListener('click', (e) => { if (!e.target.closest('input,button,details')) this.select(id); });
    f('name').onchange = (e) => set({ name: e.target.value.trim().slice(0, 24) || dev().name });
    f('volume').oninput = (e) => set({ volume: Number(e.target.value) });
    f('lat').oninput = (e) => set({ latencyMs: Number(e.target.value) });
    f('latNum').onchange = (e) => set({ latencyMs: Math.max(-1000, Math.min(1000, Number(e.target.value) || 0)) });
    f('muted').onchange = (e) => set({ muted: e.target.checked });
    f('bass').onchange = (e) => set({ caps: { ...dev().caps, bass: e.target.checked } });
    f('beep').onclick = () => {
      if (id === 'self') return this.selfEngine?.beep();
      for (const c of this.link?.clients.values() || []) if (c.did === id) this.link.send(c, { t: 'beep' });
      const g = $(`#canvas .dev[data-id="${CSS.escape(id)}"]`);
      if (g) { g.classList.remove('flash'); void g.getBBox(); g.classList.add('flash'); }
    };
    f('remove').onclick = async () => { if (await ask('移除这台设备的记录？')) { delete H.devices[id]; this.changed(); } };
    f('locked').onchange = (e) => {
      const cur = dev().override;
      const assign = e.target.checked && !cur.assign?.length ? (plan()?.assign || []).filter((k) => k !== 'all') : cur.assign;
      setOv({ locked: e.target.checked, assign });
    };
    f('gOn').onchange = (e) => setOv({ gain: e.target.checked ? plan()?.autoGain ?? 1 : null });
    f('dOn').onchange = (e) => setOv({ delayMs: e.target.checked ? plan()?.delayMs ?? 0 : null });
    f('pOn').onchange = (e) => setOv({ pan: e.target.checked ? plan()?.pan ?? 0 : null });
    f('gain').oninput = (e) => setOv({ gain: Number(e.target.value) });
    f('delay').oninput = (e) => setOv({ delayMs: Number(e.target.value) });
    f('pan').oninput = (e) => setOv({ pan: Number(e.target.value) });
    return { root, f, assignSig: null };
  },

  updateCard(c, d, plan) {
    const { f, root } = c;
    const setVal = (e, v, prop = 'value') => { if (document.activeElement !== e) e[prop] = v; };
    const s = d.stats || {};
    root.style.setProperty('--c', d.color);
    root.classList.toggle('selected', this.selected === d.id);
    f('icon').textContent = TYPE_ICON[d.type] || '💻';
    setVal(f('name'), d.name);
    f('online').textContent = d.id === 'self' ? '本机' : d.online ? '在线' : '离线';
    f('online').className = 'badge ' + (d.online ? 'ok' : 'bad');
    const n = (v, dd = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(dd));
    const badges = [];
    if (d.id === 'self' && this.selfEngine) {
      const li = this.selfEngine.loadInfo;
      badges.push(li.loaded === li.needed ? '<span class="badge ok">就绪</span>' : '<span class="badge warn">加载中</span>');
      f('stats').textContent = `输出延迟 ${n((this.selfEngine.ctx.outputLatency || 0) * 1000)}ms`;
    } else if (d.online) {
      badges.push(s.unlocked ? '<span class="badge ok">🔊 已启用声音</span>' : '<span class="badge warn">等待点击启用</span>');
      if (!s.synced) badges.push('<span class="badge warn">时钟同步中</span>');
      badges.push(s.loading ? `<span class="badge warn">下载音频 ${s.dl ?? 0}%</span>` : s.ready ? '<span class="badge ok">就绪</span>' : '');
      if (s.error) badges.push(`<span class="badge bad" title="${esc(s.error)}">错误</span>`);
      const liveTxt = s.live ? ` · 实时：收到 ${s.live.got} 段，迟到 ${s.live.late}` : '';
      f('stats').textContent = `往返 ${n(s.rtt)}ms · 时钟抖动 ${n(s.jitter, 1)}ms · 输出延迟 ${n(s.out)}ms · 同步偏差 ${n(s.drift, 1)}ms${liveTxt}`;
    } else f('stats').textContent = '';
    f('badges').innerHTML = badges.join(' ');
    if (plan) {
      const a = H.mode === 'split' ? ` · 负责 <b>${plan.assign.map((k) => esc(assignLabel(H, k))).join(' + ') || '无'}</b>` : '';
      f('plan').innerHTML = `距离 ${plan.distance.toFixed(2)}m · 方位 ${plan.azimuth.toFixed(0)}° · 增益 ${Math.round(plan.autoGain * 100)}% · 位置延迟 ${plan.delayMs.toFixed(1)}ms${a}`;
    } else f('plan').textContent = '';
    setVal(f('volume'), d.volume); f('volVal').textContent = Math.round(d.volume * 100) + '%';
    setVal(f('lat'), d.latencyMs); setVal(f('latNum'), d.latencyMs);
    setVal(f('muted'), d.muted, 'checked'); setVal(f('bass'), !!d.caps?.bass, 'checked');
    f('remove').style.display = d.online ? 'none' : '';
    const o = d.override || {};
    const has = (v) => v !== null && v !== undefined;
    setVal(f('locked'), !!o.locked, 'checked');
    setVal(f('gOn'), has(o.gain), 'checked'); setVal(f('dOn'), has(o.delayMs), 'checked'); setVal(f('pOn'), has(o.pan), 'checked');
    setVal(f('gain'), o.gain ?? plan?.autoGain ?? 1); setVal(f('delay'), o.delayMs ?? plan?.delayMs ?? 0); setVal(f('pan'), o.pan ?? plan?.pan ?? 0);
    f('gain').disabled = !has(o.gain); f('delay').disabled = !has(o.delayMs); f('pan').disabled = !has(o.pan);
    f('gainVal').textContent = Math.round((o.gain ?? plan?.autoGain ?? 1) * 100) + '%';
    f('delayVal').textContent = (o.delayMs ?? plan?.delayMs ?? 0).toFixed(1) + 'ms';
    f('panVal').textContent = (o.pan ?? plan?.pan ?? 0).toFixed(2);
    const options = H.mode === 'split' ? assignOptions(H) : [];
    const sig = JSON.stringify([options, o.assign, o.locked]);
    if (sig !== c.assignSig) {
      c.assignSig = sig;
      const box = f('assignBox');
      if (!options.length) box.innerHTML = '<div class="muted small">手动绑定在“声音分工”模式下可用。</div>';
      else {
        box.innerHTML = `<div class="small muted">手动绑定（可多选）：</div><div class="assign-list">${options.map((op) =>
          `<label><input type="checkbox" value="${esc(op.key)}" ${o.assign?.includes(op.key) ? 'checked' : ''} ${o.locked ? '' : 'disabled'} /> ${esc(op.label)}</label>`).join('')}</div>`;
        $$('input', box).forEach((cb) => (cb.onchange = () => {
          H.devices[d.id].override = { ...H.devices[d.id].override, assign: $$('input:checked', box).map((x) => x.value) };
          this.changed();
        }));
      }
    }
  },
};

function arcSpot(n) {
  const k = n % 9;
  const a = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.5;
  const R = Math.min(2.5, H.listener.y * 0.9);
  return {
    x: Math.min(H.size.w, Math.max(0, H.listener.x + Math.sin(a) * R)),
    y: Math.min(H.size.h, Math.max(0, H.listener.y - Math.cos(a) * R)),
  };
}

function decodeWire(w, did) {
  if (!w || w.v !== 1) return null;
  const g = w.g && { id: w.g.id, kind: w.g.k, name: w.g.n, loop: !!w.g.l, duration: w.g.d, tracks: w.g.t.map(([src, ch]) => ({ src, channels: ch })) };
  const pb = { status: PB_NAME[w.pb[0]], S: w.pb[1], o: w.pb[2] };
  const p = w.p[did];
  const base = { group: g, pb, mode: w.m, ld: w.ld };
  if (!p || !g) return { ...base, plan: null };
  const [gain, posDelay, latency, srcs, label, color, name] = p;
  return {
    ...base,
    plan: {
      gain, posDelay, latency, D: posDelay + latency, label, color, name,
      sources: srcs.filter(([i]) => g.tracks[i]).map(([i, mix, filters]) => ({
        src: g.tracks[i].src,
        mix: mix[0] === 'l' ? { type: 'lr', wl: mix[1], wr: mix[2] } : mix[0] === 'c' ? { type: 'ch', index: mix[1] } : { type: 'stereo' },
        filters: filters.map(([t, freq]) => ({ type: t === 'l' ? 'lowpass' : 'highpass', freq })),
      })),
    },
  };
}

// =====================================================================
//                              播放节点
// =====================================================================
class Clock {
  constructor() { this.reset(); }
  reset() { this.samples = []; this.offset = null; this.rtt = null; this.jitter = null; }
  get synced() { return this.offset !== null && this.samples.length >= 3; }
  now() { return performance.now() + (this.offset ?? 0); }
  add(c, s) {
    const t1 = performance.now(), rtt = t1 - c;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, offset: s + rtt / 2 - t1, at: t1 });
    this.samples = this.samples.filter((x) => t1 - x.at < 90000).slice(-40);
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 3)));
    const est = best.reduce((a, b) => a + b.offset, 0) / best.length;
    this.jitter = best.length > 1 ? Math.max(...best.map((b) => b.offset)) - Math.min(...best.map((b) => b.offset)) : null;
    this.rtt = best[0].rtt;
    this.offset = this.offset === null || Math.abs(est - this.offset) > 40 ? est : this.offset + (est - this.offset) * 0.3;
  }
}

const node = {
  link: null, did: null, name: '', clock: new Clock(), engine: null, ep: null, cur: null, files: new Map(),

  async start(code) {
    this.code = code;
    try { this.did = sessionStorage.getItem('sm-did') || rid(8); sessionStorage.setItem('sm-did', this.did); } catch { this.did = rid(8); }
    this.name = $('#name').value.trim() || `${TYPE_NAME[detectDeviceType()]} ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
    store.set('sm-name', this.name);
    this.engine = new Engine(this.clock, { fetchFile: (id) => this.fetchFile(id) });
    window.smNode = this;
    try { await this.engine.unlock(); } catch { this.engine.error = '无法启用声音，请再点一次页面'; }
    $('#overlay').remove();
    this.engine.addEventListener('status', () => this.render());
    this.decoder = new LiveDecoder(this.engine.ctx, (ts, buf) => this.engine.pushLive(ts, buf));
    if (!window.Peer) { this.err = '连接库没加载出来，检查网络后刷新'; return this.render(); }
    const opus = await opusDecodeSupported();
    this.link = new NodeLink(code, () => ({ t: 'hello', did: this.did, name: this.name, type: detectDeviceType(), opus }));
    this.link.addEventListener('status', (e) => {
      const s = e.detail;
      this.linkStatus = { open: '已连接控制端', connecting: '连接中…', lost: '连接断开，重连中…', 'no-host': '找不到这个房间（控制端没打开或房间码不对），重试中…', 'signal-error': '连不上信令服务器，重试中…' }[s] || s;
      if (s === 'open') { this.clock.reset(); this.burst(16); for (const f of this.files.values()) if (!f.done) this.link.send({ t: 'getFile', id: f.id }); }
      this.render();
    });
    this.link.addEventListener('msg', (e) => this.onMsg(e.detail));
    this.link.addEventListener('bin', (e) => this.onBin(e.detail));
    setInterval(() => this.burst(5), 10000);
    setInterval(() => this.sendStats(), 2000);
    setInterval(() => this.render(), 500);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.burst(8));
    this.render();
  },

  onMsg(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state') {
      if (m.st?.ep !== this.ep) { this.ep = m.st.ep; this.clock.reset(); this.burst(16); }
      this.cur = decodeWire(m.st, this.did);
      this.engine.update(this.cur);
      this.render();
    } else if (m.t === 'pong') {
      if (m.ep !== this.ep && this.ep) return;
      const was = this.clock.synced;
      this.clock.add(m.c, m.s);
      if (!was && this.clock.synced) this.engine.apply();
    } else if (m.t === 'beep') {
      this.engine.beep();
      const el = $('#nodeMain'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    } else if (m.t === 'fileErr') {
      const f = this.files.get(m.id);
      if (f && !f.done) { f.reject(new Error('控制端找不到这个文件（控制端刷新后需要重新添加）')); this.files.delete(m.id); }
    }
  },

  onBin({ hdr, payload }) {
    if (hdr.k === 'l') {
      try { hdr.c === 'o' ? this.decoder.opus(hdr.ts, payload) : this.decoder.pcm(hdr.ts, payload, hdr.sr || 48000); } catch {}
    } else if (hdr.k === 'f') {
      const f = this.files.get(hdr.id);
      if (!f || f.done) return;
      if (!f.data || f.data.byteLength !== hdr.total) { f.data = new Uint8Array(hdr.total); f.got = 0; f.seen = new Set(); }
      if (f.seen.has(hdr.off)) return;
      f.seen.add(hdr.off);
      f.data.set(payload, hdr.off);
      f.got += payload.byteLength; f.total = hdr.total; f.last = Date.now();
      if (f.got >= hdr.total) { f.done = true; f.resolve(f.data.buffer); }
    }
  },

  fetchFile(id) {
    let f = this.files.get(id);
    if (f) return f.promise;
    f = { id, got: 0, total: 0, done: false, last: Date.now() };
    f.promise = new Promise((ok, bad) => { f.resolve = ok; f.reject = bad; });
    this.files.set(id, f);
    this.link?.send({ t: 'getFile', id });
    // 太久没动静就重新要
    const watch = setInterval(() => {
      if (f.done || !this.files.has(id)) return clearInterval(watch);
      if (Date.now() - f.last > 8000) { f.last = Date.now(); f.data = null; this.link?.send({ t: 'getFile', id }); }
    }, 2000);
    return f.promise;
  },
  dlPercent() {
    const pending = [...this.files.values()].filter((f) => !f.done);
    if (!pending.length) return null;
    const got = pending.reduce((a, f) => a + f.got, 0), total = pending.reduce((a, f) => a + (f.total || 0), 0);
    return total ? Math.round((got / total) * 100) : 0;
  },

  burst(n) {
    if (!this.link?.connected || this.bursting) return;
    this.bursting = true;
    let i = 0;
    const tick = () => {
      if (i++ >= n || !this.link.connected) { this.bursting = false; return; }
      this.link.send({ t: 'ping', c: performance.now() });
      setTimeout(tick, 80);
    };
    tick();
  },

  sendStats() {
    if (!this.link?.connected) return;
    const li = this.engine.loadInfo, e = this.engine, isLive = this.cur?.group?.kind === 'live';
    this.link.send({
      t: 'stats',
      stats: {
        rtt: this.clock.rtt === null ? null : r1(this.clock.rtt), jitter: this.clock.jitter === null ? null : r1(this.clock.jitter),
        out: Math.round((e.ctx.outputLatency || e.ctx.baseLatency || 0) * 1000),
        drift: isLive ? (e.liveStats.err === null ? null : r1(e.liveStats.err)) : e.drift === null ? null : r1(e.drift),
        unlocked: e.unlocked && e.ctx.state === 'running', synced: this.clock.synced,
        ready: li.loaded === li.needed, loading: li.loaded < li.needed, dl: this.dlPercent(),
        live: isLive ? { got: e.liveStats.got, late: e.liveStats.late } : null,
        error: e.error ? String(e.error).slice(0, 100) : null,
      },
    });
  },

  setSelf(patch) { this.link?.send({ t: 'self', ...patch }); },

  render() {
    const e = this.engine; if (!e) return;
    $('#roomLine').textContent = `房间 ${this.code} · ${this.err ? '⚠️ ' + this.err : this.linkStatus || '连接中…'}`;
    const cur = this.cur, plan = cur?.plan, isLive = cur?.group?.kind === 'live';
    $('#bigname').textContent = plan?.name || this.name;
    if (plan?.color) $('#nodeMain').style.background = `radial-gradient(circle at 50% 30%, ${plan.color}88, #0f1115 70%)`;
    $('#assign').textContent = e.error ? '⚠️ ' + e.error : !plan ? (this.link?.connected ? '控制端还没分配到本机' : '等待控制端') : plan.gain <= 0.001 ? '静音中' : cur.mode ? (plan.label ? '负责：' + plan.label : '本轮没有分配到声音') : '协同播放';
    $('#vol').style.width = `${Math.min(100, (plan?.gain || 0) * 100)}%`;
    if (cur?.pb) {
      const pb = cur.pb, g = cur.group;
      if (isLive) $('#pbLine').textContent = `🔴 电脑实时音源 · ${pb.status === 'playing' ? `正在接收（缓冲 ${cur.ld} ms）` : '控制端还没开始共享'}`;
      else {
        const pos = pb.status === 'playing' ? Math.max(pb.o, pb.o + (this.clock.now() - pb.S) / 1000) : pb.o;
        const st = { playing: '▶ 播放中', paused: '❚❚ 已暂停', stopped: '■ 已停止' }[pb.status];
        $('#pbLine').textContent = `${g?.name || '未选曲目'} · ${st} · ${g?.loop ? '循环 ' + fmt(pos % (g.duration || 1)) : `${fmt(pos)} / ${fmt(g?.duration || 0)}`}`;
      }
    }
    if (plan && document.activeElement !== $('#lat')) { $('#lat').value = plan.latency; $('#latVal').textContent = `${plan.latency} ms`; }
    const li = e.loadInfo, n = (v, d = 0) => (v === null || v === undefined ? '—' : v.toFixed(d));
    const dl = this.dlPercent();
    const rows = [
      ['时钟同步', this.clock.synced ? `往返 ${n(this.clock.rtt, 1)} ms · 抖动 ${n(this.clock.jitter, 1)} ms` : this.link?.connected ? '同步中…' : '等待连接'],
      isLive
        ? ['实时音频', `收到 ${e.liveStats.got} 段 · 迟到丢弃 ${e.liveStats.late} · 重新对齐 ${e.liveStats.resyncs} 次`]
        : ['音频加载', li.needed === 0 ? '—' : li.loaded === li.needed ? '✅ 已就绪' : dl !== null ? `从控制端下载中 ${dl}%` : `解码中 ${li.loaded}/${li.needed}`],
      ['本机延迟', plan ? `位置补偿 ${n(plan.posDelay, 1)} ms · 手动 ${plan.latency} ms` : '—'],
      ['输出延迟', `${((e.ctx.outputLatency || e.ctx.baseLatency || 0) * 1000).toFixed(0)} ms（浏览器报告值）`],
      ['同步偏差', isLive ? (e.liveStats.err === null ? '—' : `${e.liveStats.err.toFixed(1)} ms`) : e.drift === null ? '—' : `${e.drift.toFixed(1)} ms · 已重新对齐 ${e.resyncs} 次`],
      ['音频状态', `${e.ctx.state} · ${e.ctx.sampleRate} Hz`],
    ];
    $('#stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  },
};

function startNode(code) {
  $('#landing').hidden = true;
  $('#nodeView').hidden = false;
  $('#nCodeTitle').textContent = code;
  $('#name').value = store.get('sm-name', '') || `${TYPE_NAME[detectDeviceType()]} ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
  $('#go').onclick = () => node.start(code);
}
$('#lat').oninput = (e) => { $('#latVal').textContent = `${e.target.value} ms`; node.setSelf({ latencyMs: Number(e.target.value) }); };
$('#rename').onclick = async () => {
  const v = await ask('设备名称', { input: node.name });
  if (v && v.trim()) { node.name = v.trim().slice(0, 24); store.set('sm-name', node.name); node.setSelf({ name: node.name }); }
};
$('#testBeep').onclick = () => node.engine?.beep();
