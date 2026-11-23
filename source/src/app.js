// SoundMesh 独立网页版：控制端 + 播放节点；设备之间 WebRTC 直连；支持电脑实时音源
import { computeMix, assignLabel, assignOptions, guessRole } from './mix.js';
import { Engine, motionAngle } from './engine.js';
import { BUILTIN_GROUPS } from './synth.js';
import { MultiHostLink, AutoNodeLink, packBin } from './transport.js';
import { LiveCapture, LiveDecoder, opusDecodeSupported, pcmEncode, StreamEncoder } from './live.js';
import { Separator, STEMS, STEM_NAMES } from './separator.js';
import { searchLyrics, parseLRC, lineAt } from './lyrics.js';
import { MicRecorder, detectChirps, median, analyzeWindows } from './calib.js';

// ---------------- 后台不降速的计时器 ----------------
// 标签页切到后台后，浏览器会把 setTimeout/setInterval 降到每秒一次，静音页面 5 分钟后甚至每分钟一次。
// 后台线程（Worker）里的计时器不受这个限制，所以把整个页面（包括连接库）的计时器都换成由 Worker 驱动。
(function installWorkerTimers() {
  const src = `const t=new Map();onmessage=(e)=>{const d=e.data;if(d.c==='set'){const f=()=>{postMessage(d.id);if(d.r&&t.has(d.id))t.set(d.id,setTimeout(f,d.ms));else t.delete(d.id);};t.set(d.id,setTimeout(f,d.ms));}else{clearTimeout(t.get(d.id));t.delete(d.id);}};`;
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); } catch { return; }
  const oSet = window.setTimeout.bind(window), oInt = window.setInterval.bind(window);
  const oClrT = window.clearTimeout.bind(window), oClrI = window.clearInterval.bind(window);
  const cbs = new Map();
  let next = 1e7;
  w.onmessage = (e) => {
    const c = cbs.get(e.data);
    if (!c) return;
    if (!c.r) cbs.delete(e.data);
    try { c.fn(...c.args); } catch (err) { queueMicrotask(() => { throw err; }); }
  };
  w.onerror = () => { // Worker 出问题就退回原生计时器
    window.setTimeout = oSet; window.setInterval = oInt; window.clearTimeout = oClrT; window.clearInterval = oClrI;
  };
  const make = (r, orig) => (fn, ms = 0, ...args) => {
    if (typeof fn !== 'function') return orig(fn, ms, ...args);
    const id = next++;
    cbs.set(id, { fn, args, r });
    w.postMessage({ c: 'set', id, ms: Math.max(r ? 4 : 0, Number(ms) || 0), r });
    return id;
  };
  const clear = (orig) => (id) => {
    if (cbs.delete(id)) w.postMessage({ c: 'clear', id });
    else orig(id);
  };
  window.setTimeout = make(false, oSet); window.setInterval = make(true, oInt);
  window.clearTimeout = clear(oClrT); window.clearInterval = clear(oClrI);
})();

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
// 实时音源：完整混音 + （开启拆声部时）四个声部
function liveGroup(stems) {
  const tracks = [{ id: 'live', name: '完整混音', src: 'live', channels: 2, duration: 0, role: 'mix' }];
  if (stems) for (const st of STEMS) tracks.push({ id: 'lv-' + st, name: STEM_NAMES[st], src: 'live:' + st, channels: 1, duration: 0, role: st });
  return { id: 'live', name: '电脑实时音源（YouTube / Spotify…）', kind: 'live', loop: false, duration: 0, tracks };
}
// 歌曲当前位置（秒），用于歌词滚动。ly = { a, s, o }：实时音源用“点一句对准”的锚点，文件用播放进度 + 偏移
function songPos(t, cur, ly) {
  if (!cur || !ly) return null;
  const { pb, group } = cur;
  if (group?.kind === 'live') return ly.a == null ? null : ly.s + (t - ly.a) / 1000 + (ly.o || 0);
  if (!pb) return null;
  let p = pb.status === 'playing' ? Math.max(pb.o, pb.o + (t - pb.S) / 1000) : pb.o;
  if (group?.loop && group.duration) p %= group.duration;
  return p + (ly.o || 0);
}
function renderLyricLines(box, lines, idx, clickable) {
  if (box.__lines !== lines) {
    box.__lines = lines;
    box.innerHTML = lines.map((l, i) => `<div class="ly-line" data-i="${i}">${esc(l.text) || '♪'}</div>`).join('');
    box.__idx = -2;
    if (clickable) $$('.ly-line', box).forEach((el) => (el.onclick = () => clickable(Number(el.dataset.i))));
  }
  if (box.__idx === idx) return;
  box.__idx = idx;
  $$('.ly-line.on', box).forEach((el) => el.classList.remove('on'));
  const el = box.children[idx];
  if (el) { el.classList.add('on'); box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' }); }
}
function renderLyricStrip(box, lines, idx, hint) {
  if (!lines?.length) { box.hidden = true; return; }
  box.hidden = false;
  const cur = lines[idx]?.text, next = lines[idx + 1]?.text ?? (idx < 0 ? lines[0]?.text : '');
  const key = idx + '|' + hint;
  if (box.__key === key) return;
  box.__key = key;
  box.innerHTML = idx < 0
    ? `<div class="ly-cur muted">${esc(hint || '♪')}</div><div class="ly-next">${esc(next || '')}</div>`
    : `<div class="ly-cur">${esc(cur || '♪')}</div><div class="ly-next">${esc(next || '')}</div>`;
}

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
    library: [], currentGroupId: 'demo-mix', liveDelay: 350, autoDelay: true, opus: true, pcPlay: true, liveStems: false, lyrics: null, ly: { a: null, s: 0, o: 0 }, motion: { y: 'off', p: 8, d: 0.85, t0: 0 },
    playback: { status: 'stopped', startServerTime: 0, startOffset: 0 }, colorIdx: 0,
  };
}

function startHost(code, resume) {
  const saved = store.get('sm-host-state', null);
  H = saved ? { ...defaultHostState(code), ...saved, code } : defaultHostState(code);
  H.library = [liveGroup(H.liveStems), ...structuredClone(BUILTIN_GROUPS), ...(H.library || []).filter((g) => g.kind === 'file')];
  if (!H.library.some((g) => g.id === H.currentGroupId) || H.currentGroupId === 'live') H.currentGroupId = 'demo-mix';
  H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 };
  H.ly = { a: null, s: 0, o: H.ly?.o || 0 };
  if (!saved?.v2) { H.liveDelay = 350; H.autoDelay = true; H.v2 = true; } // 旧版本默认 800ms 太保守
  // 新建房间：设备从空的开始（只保留曲目和规则设置）；“回到上次的房间”才保留设备、位置和校准
  if (!resume) { H.devices = {}; H.colorIdx = 0; }
  for (const d of Object.values(H.devices)) d.online = false;
  delete H.devices.self;
  $('#landing').hidden = true;
  $('#hostView').hidden = false;
  host.init(code, resume);
}

const host = {
  link: null, selfEngine: null, lastWire: '', pubTimer: null, selected: null, files: new Map(), sending: new Set(),
  live: new LiveCapture(hostNow), sep: null, encoders: new Map(), need: {},

  init(code, resume) {
    this.setCode(code);
    this.bindUI();
    this.render();
    if (!window.Peer) return this.status('连接库没加载出来，检查网络后刷新', 'bad');
    this.link = new MultiHostLink(code);
    let tries = 0;
    this.link.addEventListener('status', (e) => {
      const s = e.detail;
      if (s === 'open') this.status('已上线', 'ok');
      else if (s === 'signal-lost') this.status(window.Trystero ? '主通道断开，备用通道在线（已连上的设备不受影响）' : '信令服务器断开，重连中（已连上的设备不受影响）', 'warn');
      else if (s === 'taken') {
        // 刚刷新时旧连接可能还没释放，等一下再试；还不行就换个房间码
        if (resume && tries++ < 4) { this.status('房间码被占用，重试中…', 'warn'); setTimeout(() => this.link.restartWithCode(H.code), 3000); }
        else { const c = newCode(); this.setCode(c); this.link.restartWithCode(c); }
      } else this.status('连接问题：' + s.replace('error:', '') + '（检查网络）', 'bad');
    });
    this.link.addEventListener('msg', (e) => this.onMsg(e.detail));
    this.link.addEventListener('peers', () => this.onPeers());
    this.live.addEventListener('chunk', (e) => this.onLiveChunk(e.detail));
    this.live.addEventListener('state', (e) => this.onLiveState(e.detail));
    setInterval(() => this.tick(), 500);
    window.smHost = this; // 调试用
    // 控制端被最小化/被游戏挡住时：先把缓冲加大到至少 600ms，回到前台再恢复
    document.addEventListener('visibilitychange', () => {
      if (!H.autoDelay) return;
      if (document.visibilityState === 'hidden' && this.live.running && H.liveDelay < 600) {
        this.boostFrom = H.liveDelay; H.liveDelay = 600; this.lastBump = Date.now(); this.changed();
      } else if (document.visibilityState === 'visible' && this.boostFrom) {
        if (H.liveDelay === 600) H.liveDelay = this.boostFrom; // 期间没有因为卡顿再加大，才恢复原值
        this.boostFrom = null; this.changed();
      }
    });
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
      // 同一台设备换了通道重连：旧连接作废，避免收到两份音频
      for (const o of this.link.clients.values()) if (o !== c && o.did === did) o.did = null;
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
      if (H.lyrics) this.link.send(c, { t: 'lyrics', ly: H.lyrics });
      this.lastWire = ''; // 新设备：马上发一次完整状态
      this.publish();
    } else if (msg.t === 'ping') {
      this.link.send(c, { t: 'pong', c: msg.c, s: hostNow(), ep: EPOCH });
    } else if (msg.t === 'stats' && H.devices[c.did]) {
      const prevLate = H.devices[c.did].stats?.live?.late;
      const wasHidden = H.devices[c.did].stats?.hidden;
      H.devices[c.did].stats = msg.stats || {};
      // 有手机切到后台：它的网页会被系统降速，先把缓冲提到至少 800ms 给它留余量
      if (H.autoDelay && this.live.running && msg.stats?.hidden && !wasHidden && H.liveDelay < 800) {
        H.liveDelay = 800; this.lastBump = Date.now();
        toast(`${H.devices[c.did].name} 切到后台了，缓冲自动加到 800 ms`);
        this.changed();
      }
      // 自动调节：某台设备的音频分段开始“迟到”（来不及播），就把缓冲加大一点
      const late = msg.stats?.live?.late;
      if (H.autoDelay && this.live.running && Number.isFinite(late) && Number.isFinite(prevLate) && late > prevLate + 2 && H.liveDelay < 1500) {
        H.liveDelay = Math.min(1500, H.liveDelay + 150);
        this.lastBump = Date.now();
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
    else if (['micReady', 'micErr', 'measureResult'].includes(msg.t) && this.calWait && c.did === this.calWait.did) {
      const w = this.calWait; this.calWait = null; w.resolve(msg);
    }
  },

  onPeers() {
    const online = new Set([...this.link.clients.values()].filter((c) => c.did && this.link.isOpen(c)).map((c) => c.did));
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
      if (c.via === 'backup') { // 备用通道自带分块和流控：整个文件一次发
        this.link.sendBin(c, packBin({ k: 'f', id, off: 0, total }, new Uint8Array(buf)));
        return;
      }
      for (let off = 0; off < total; off += CH) {
        while (this.link.buffered(c) > 1 << 20) { await sleep(20); if (!c.bin?.open) return; }
        if (!this.link.sendBin(c, packBin({ k: 'f', id, off, total }, new Uint8Array(buf, off, Math.min(CH, total - off))))) return;
      }
    } finally { this.sending.delete(key); }
  },

  // ---------- 实时音源 ----------
  updateOpusWant() {},
  needs(did, src) { return !!this.need[did]?.has(src); },
  anyNeeds(src) { return Object.values(this.need).some((set) => set.has(src)); },
  onLiveChunk({ frame, ts, l, r }) {
    if (H.currentGroupId !== 'live') return;
    // 电脑自己处理慢了多少：这段声音采集完到现在过了多久（玩游戏/最小化时 CPU 被抢走会变大）
    const lag = hostNow() - (ts + 20);
    this.lagMax = Math.max(this.lagMax || 0, lag);
    const now = Date.now();
    if (now - (this.lagWin || 0) > 2000) {
      this.lagShown = this.lagMax; this.lagMax = 0; this.lagWin = now;
      // 处理延迟已经吃掉大部分缓冲 → 自动加大（留 150ms 给网络和手机）
      if (H.autoDelay && this.lagShown + 150 > H.liveDelay && H.liveDelay < 1500) {
        H.liveDelay = Math.min(1500, Math.ceil((this.lagShown + 200) / 50) * 50);
        this.lastBump = now;
        toast(`电脑处理跟不上（慢了 ${Math.round(this.lagShown)} ms），缓冲自动加到 ${H.liveDelay} ms`);
        this.changed();
      }
    }
    this.dispatch('live', ts, [l, r]);
    // 拆声部：只有当有设备需要某个声部时才运行
    if (H.liveStems && STEMS.some((st) => this.anyNeeds('live:' + st))) {
      this.sep = this.sep || new Separator(48000, 960);
      for (const o of this.sep.push(frame, l, r)) {
        const ts2 = this.live.tsOf(o.frame);
        for (const st of STEMS) this.dispatch('live:' + st, ts2, [o.stems[st]]);
      }
    } else this.sep = null;
  },
  dispatch(src, ts, planes) {
    if (this.selfEngine && this.needs('self', src)) {
      const ctx = this.selfEngine.ctx, buf = ctx.createBuffer(planes.length, planes[0].length, 48000);
      planes.forEach((p, i) => buf.copyToChannel(p, i));
      this.selfEngine.pushLive(ts, buf, src);
    }
    let pcm = null, wantOpus = false;
    for (const c of this.link?.clients.values() || []) {
      if (!c.did || !this.needs(c.did, src)) continue;
      if (H.opus && c.opus && this.encoderFor(src, planes.length).ok) { wantOpus = true; continue; }
      if (this.link.buffered(c) > 512 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; } // 网络跟不上：丢这一段
      pcm = pcm || pcmEncode(planes);
      this.link.sendBin(c, packBin({ k: 'l', ts, c: 'p', sr: 48000, ch: planes.length, s: src }, pcm));
    }
    if (wantOpus) this.encoderFor(src, planes.length).encode(ts, planes);
  },
  encoderFor(src, ch) {
    let e = this.encoders.get(src);
    if (!e) {
      e = new StreamEncoder(ch, (ts, data) => {
        for (const c of this.link?.clients.values() || []) {
          if (!c.did || !c.opus || !H.opus || !this.needs(c.did, src)) continue;
          if (this.link.buffered(c) > 512 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; }
          this.link.sendBin(c, packBin({ k: 'l', ts, c: 'o', ch, s: src }, data));
        }
      });
      this.encoders.set(src, e);
    }
    return e;
  },
  setLiveStems(on) {
    H.liveStems = on;
    H.library[0] = liveGroup(on);
    this.sep = null;
    if (on && H.currentGroupId === 'live' && H.mode !== 'split') { H.mode = 'split'; toast('已切换到“声音分工”模式，各设备按位置分配人声/鼓/贝斯/伴奏'); }
    this.libSig = null;
    this.changed();
  },
  resetLivePipeline() {
    this.sep = null;
    for (const e of this.encoders.values()) e.close();
    this.encoders.clear();
  },
  onLiveState(on) {
    this.resetLivePipeline(); // 每次开始/停止共享都从干净的状态开始
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
    const autoSelf = !this.selfEngine && H.pcPlay !== false;
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
      v: 1, ep: EPOCH, ld: H.liveDelay, mo: H.motion.y !== 'off' ? { y: H.motion.y, p: H.motion.p, d: H.motion.d, t0: H.motion.t0 } : null, ly: H.lyrics ? { id: H.lyrics.id, a: H.ly.a, s: H.ly.s, o: H.ly.o } : null, pb: [PB_CODE[pb.status], Math.round(pb.startServerTime), r3(pb.startOffset)], m: H.mode === 'split' ? 1 : 0,
      g: g ? { id: g.id, k: g.kind, n: g.name.slice(0, 60), l: g.loop ? 1 : 0, d: r3(g.duration || 0), t: g.tracks.map((t) => [t.src, t.channels]) } : null,
      p: {},
    };
    for (const [did, pl] of Object.entries(plans)) {
      const d = H.devices[did];
      const idx = (id) => g.tracks.findIndex((t) => t.id === id);
      w.p[did] = [r3(pl.gain), r1(pl.delayMs), d.latencyMs,
        pl.sources.map((s) => [idx(s.trackId), s.mix.type === 'lr' ? ['l', r3(s.mix.wl), r3(s.mix.wr)] : s.mix.type === 'ch' ? ['c', s.mix.index] : ['s'], s.filters.map((f) => [f.type[0], Math.round(f.freq)])]),
        (H.mode === 'split' ? pl.assign.map((k) => assignLabel(H, k)).join(' + ') : '协同播放').slice(0, 60), d.color, d.name, Math.round(pl.azimuth)];
    }
    return w;
  },

  publish() {
    const plans = this.plans();
    const g = this.group();
    this.need = {};
    for (const [did, pl] of Object.entries(plans)) this.need[did] = new Set(pl.sources.map((x) => g?.tracks.find((t) => t.id === x.trackId)?.src).filter(Boolean));
    const w = this.wire(plans);
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
    // 自动调节：连续 20 秒没有设备卡顿，就把缓冲往下压 20ms（最低 100ms），慢慢找到最低又不卡的值
    const anyHidden = Object.values(H.devices).some((d) => d.online && d.stats?.hidden);
    if (H.autoDelay && this.live.running && H.liveDelay > 100 && document.visibilityState === 'visible' && !anyHidden) {
      const now = Date.now();
      this.lastBump = this.lastBump || now;
      this.lastLower = this.lastLower || now;
      if (now - this.lastBump > 20000 && now - this.lastLower > 10000) {
        this.lastLower = now;
        H.liveDelay = Math.max(100, H.liveDelay - 20);
        this.changed();
      }
    }
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
    H.ly = { a: null, s: 0, o: 0 };
    if (!$('#lyQ').value || this.lyAutoQ === $('#lyQ').value) { const g = H.library.find((x) => x.id === id); this.lyAutoQ = g && g.kind === 'file' ? g.name : ''; $('#lyQ').value = this.lyAutoQ; }
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
    $('#liveStems').onchange = (e) => this.setLiveStems(e.target.checked);
    $('#pcPlay').onchange = (e) => {
      H.pcPlay = e.target.checked;
      // 正在共享时立刻生效
      if (this.live.running && !H.pcPlay && this.selfEngine) this.toggleSelf();
      else if (this.live.running && H.pcPlay && !this.selfEngine && this.live.surface === 'browser') this.toggleSelf();
      this.changed();
    };
    $('#opusOn').onchange = (e) => { H.opus = e.target.checked; this.updateOpusWant(); this.changed(); };
    $$('#modeSeg button').forEach((b) => (b.onclick = () => { H.mode = b.dataset.mode; this.changed(); }));
    $$('[data-opt]').forEach((c) => (c.onchange = () => { H.options[c.dataset.opt] = c.checked; this.changed(); }));
    $('#gainPreset').onchange = (e) => { H.gainPreset = e.target.value; this.changed(); };
    const motion = () => {
      const y = $('#motionType').value;
      if (y !== H.motion.y) H.motion.t0 = Math.round(hostNow() + 300);
      H.motion = { ...H.motion, y, p: Number($('#motionSpeed').value), d: Number($('#motionDepth').value) };
      this.changed();
    };
    $('#motionType').onchange = motion; $('#motionSpeed').onchange = motion; $('#motionDepth').onchange = motion;
    const anim = () => { this.animMotion(); requestAnimationFrame(anim); };
    requestAnimationFrame(anim);
    $('#splitPreset').onchange = (e) => { H.splitPreset = e.target.value; this.changed(); };
    $('#width').oninput = (e) => { H.stereoWidth = Number(e.target.value); this.changed(); };
    const clampN = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
    const bands = () => { H.bands = { lowCut: clampN($('#lowCut').value, 40, 1000, 150), highCut: clampN($('#highCut').value, 500, 12000, 2500) }; this.changed(); };
    $('#lowCut').onchange = bands; $('#highCut').onchange = bands;
    const size = () => {
      H.size = { w: clampN($('#roomW').value, 0.5, 50, 8), h: clampN($('#roomH').value, 0.5, 50, 5) };
      for (const o of [H.listener, ...Object.values(H.devices)]) { o.x = Math.min(o.x, H.size.w); o.y = Math.min(o.y, H.size.h); }
      this.changed();
    };
    $('#roomW').onchange = size; $('#roomH').onchange = size;
    $('#clearOffline').onclick = () => {
      const n = Object.values(H.devices).filter((d) => !d.online).length;
      for (const [id, d] of Object.entries(H.devices)) if (!d.online) delete H.devices[id];
      toast(n ? `已清除 ${n} 台离线设备` : '没有离线设备');
      this.changed();
    };
    $('#deskMode').onclick = () => {
      const desk = Math.max(H.size.w, H.size.h) > 3;
      if (desk) { H.size = { w: 1.6, h: 1.3 }; H.listener = { x: 0.8, y: 1.08 }; }
      else { H.size = { w: 8, h: 5 }; H.listener = { x: 4, y: 3.5 }; }
      Object.values(H.devices).forEach((d, i) => Object.assign(d, arcSpot(i)));
      toast(desk ? '已切换到桌面模式：把设备按桌上的实际位置拖好，👑 放在你坐的位置' : '已切换回房间模式');
      this.changed();
    };
    $('#arc').onclick = () => { Object.values(H.devices).filter((d) => d.online).forEach((d, i) => Object.assign(d, arcSpot(i))); this.changed(); };
    $('#upload').onclick = () => this.addAudio();
    $('#calibBtn').onclick = () => this.calibrate();
    $('#checkBtn').onclick = () => this.checkAssign();
    $('#lySearch').onclick = () => this.lySearch();
    $('#lyQ').onkeydown = (e) => e.key === 'Enter' && this.lySearch();
    $('#lyEarly').onclick = () => { H.ly.o = Math.round((H.ly.o + 0.3) * 10) / 10; this.changed(); };
    $('#lyLate').onclick = () => { H.ly.o = Math.round((H.ly.o - 0.3) * 10) / 10; this.changed(); };
    $('#lyClear').onclick = () => { H.lyrics = null; H.ly = { a: null, s: 0, o: 0 }; this.link?.broadcast({ t: 'lyrics', ly: null }); this.changed(); };
    setInterval(() => this.renderLyrics(), 150);
    $('#calibUndo').onclick = () => {
      if (!this.calUndo) return;
      for (const [id, v] of Object.entries(this.calUndo)) if (H.devices[id]) H.devices[id].latencyMs = v;
      this.calUndo = null; $('#calibUndo').hidden = true; $('#calibOut').innerHTML = '已撤销校准';
      this.changed();
    };
    $('#selfNode').onclick = () => this.toggleSelf();
    this.bindCanvas();
  },

  // ---------- 麦克风自动校准 ----------
  waitFor(did, ms) {
    return new Promise((resolve) => {
      this.calWait = { did, resolve };
      setTimeout(() => { if (this.calWait?.resolve === resolve) { this.calWait = null; resolve(null); } }, ms);
    });
  },
  // ---------- 歌词 ----------
  async lySearch() {
    const q = $('#lyQ').value.trim();
    if (!q) return toast('输入歌名（最好加上歌手）');
    $('#lyResults').innerHTML = '<div class="muted small">搜索中…</div>';
    try {
      const list = await searchLyrics(q);
      if (!list.length) { $('#lyResults').innerHTML = '<div class="muted small">没找到，换个写法试试（比如英文歌名 + 歌手）</div>'; return; }
      this.lyList = list;
      $('#lyResults').innerHTML = list.map((x, i) => `<div class="lib-item" data-i="${i}"><span class="name">${esc(x.title)} <span class="muted">— ${esc(x.artist)}</span></span><span class="muted small">${x.synced ? '⏱ 同步' : '纯文本'} · ${fmt(x.duration || 0)}</span></div>`).join('');
      $$('#lyResults .lib-item').forEach((el) => (el.onclick = () => this.lyPick(this.lyList[Number(el.dataset.i)])));
    } catch (e) { $('#lyResults').innerHTML = `<div class="small" style="color:var(--bad)">${esc(e.message)}</div>`; }
  },
  lyPick(x) {
    H.lyrics = { id: String(x.id), title: x.title, artist: x.artist, synced: x.synced, lines: parseLRC(x.text, x.synced) };
    H.ly = { a: null, s: 0, o: 0 };
    $('#lyResults').innerHTML = '';
    this.link?.broadcast({ t: 'lyrics', ly: H.lyrics });
    this.changed();
  },
  lyAlign(i) { // 点一句 = “现在正唱到这句”
    const line = H.lyrics?.lines[i];
    if (!line || line.t === null) return;
    const g = this.group();
    if (g?.kind === 'live') H.ly = { a: Math.round(hostNow()), s: line.t, o: 0 };
    else { const base = songPos(hostNow(), { pb: { status: H.playback.status, S: H.playback.startServerTime, o: H.playback.startOffset }, group: g }, { o: 0 }); H.ly.o = Math.round((line.t - base) * 10) / 10; }
    toast('已对准：' + line.text.slice(0, 20));
    this.changed();
  },
  renderLyrics() {
    const L = H?.lyrics;
    $('#lyNow').hidden = !L;
    if (!L) { $('#lyView').innerHTML = ''; $('#lyView').__lines = null; renderLyricStrip($('#stageLyric'), null); return; }
    const g = this.group();
    const pos = songPos(hostNow(), { pb: { status: H.playback.status, S: H.playback.startServerTime, o: H.playback.startOffset }, group: g }, H.ly);
    const idx = lineAt(L.lines, pos);
    $('#lyTitle').textContent = `${L.title} — ${L.artist}`;
    $('#lyOffset').textContent = H.ly.o ? `（偏移 ${H.ly.o > 0 ? '+' : ''}${H.ly.o}s）` : '';
    const hint = !L.synced ? '这份歌词没有时间轴，只能整段显示' : g?.kind === 'live' && H.ly.a == null ? '👆 在右边歌词里点一下“正在唱的那一句”来对准' : '';
    $('#lyHint').textContent = hint;
    renderLyricLines($('#lyView'), L.lines, idx, (i) => this.lyAlign(i));
    renderLyricStrip($('#stageLyric'), L.synced ? L.lines : null, idx, hint);
  },

  async openMic(micId) {
    if (micId === 'self') {
      const ctx = this.selfEngine?.ctx || (this.calCtx ||= new (window.AudioContext || window.webkitAudioContext)());
      const recorder = new MicRecorder(ctx, hostNow);
      await recorder.start();
      return { recorder };
    }
    const client = [...this.link?.clients.values() || []].find((c) => c.did === micId);
    if (!client) throw new Error('选的录音设备不在线');
    this.link.send(client, { t: 'micPrep' });
    const r = await this.waitFor(micId, 30000);
    if (!r || r.t !== 'micReady') throw new Error(r?.msg ? '录音设备无法使用麦克风：' + r.msg : '录音设备没有回应（请在那台手机上允许麦克风）');
    return { client };
  },

  // 分工检查：各设备轮流单独出声，麦克风录下来分析每台实际在放什么
  async checkAssign() {
    if (this.calibrating) return;
    const out = (h) => ($('#checkOut').innerHTML = h);
    const g = this.group();
    const playing = g?.kind === 'live' ? this.live.running : H.playback.status === 'playing';
    if (!playing) return toast('先开始播放音乐（或开始共享电脑声音），再做分工检查');
    const micId = $('#calibMic').value;
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (!devs.length) return toast('还没有在线的播放设备');
    this.calibrating = true; $('#checkBtn').disabled = true; $('#calibBtn').disabled = true;
    let mic = null;
    try {
      out('🎙 打开麦克风中…');
      mic = await this.openMic(micId);
      const T0 = hostNow() + 1200, LEN = 2600, GAP = 300;
      const noise = { from: T0 + 100, to: T0 + 800 };
      const windows = devs.map((d, i) => ({ did: d.id, from: T0 + 1000 + i * (LEN + GAP), to: T0 + 1000 + i * (LEN + GAP) + LEN }));
      const end = windows[windows.length - 1].to + 300;
      for (const w of windows) {
        if (w.did === 'self') this.selfEngine.solo(w.from, w.to, end);
        else for (const c of this.link.clients.values()) if (c.did === w.did) this.link.send(c, { t: 'solo', from: w.from, to: w.to, end });
      }
      // 不在列表里的在线设备（理论上没有）也一起静音
      out(`🔍 各设备轮流单独出声中，请保持安静…（约 ${Math.ceil((end - hostNow()) / 1000)} 秒）`);
      let res;
      if (mic.recorder) {
        await sleep(end - hostNow());
        out('🧮 分析中…'); await sleep(30);
        res = analyzeWindows(mic.recorder.stop(), windows, noise); mic.recorder = null;
      } else {
        this.link.send(mic.client, { t: 'measure', kind: 'spectrum', end, windows, noise });
        const r = await this.waitFor(micId, end - hostNow() + 20000);
        if (!r || r.t !== 'measureResult') throw new Error('录音设备没有返回结果');
        res = r.results;
      }
      this.checkRes = Object.fromEntries(res.map((r) => [r.did, r]));
      const plans = this.plans();
      const bar = (v, color) => `<span style="display:inline-block;height:8px;width:${Math.round(v * 60)}px;background:${color};border-radius:2px"></span>`;
      out(`<div class="small muted" style="margin:4px 0">每台设备单独出声时录到的声音：<span style="color:#ff922b">■</span> 低频 <span style="color:#51cf66">■</span> 中频 <span style="color:#4dabf7">■</span> 高频</div>
        <table class="small" style="width:100%">${res.map((r) => {
          const d = H.devices[r.did], pl = plans[r.did];
          const planned = H.mode === 'split' ? pl?.assign.map((k) => assignLabel(H, k)).join(' + ') : '完整混音';
          return `<tr><td>${esc(d?.name || r.did)}<div class="muted">应放：${esc(planned || '—')}</div></td>
            <td>${bar(r.share.low, '#ff922b')}${bar(r.share.mid, '#51cf66')}${bar(r.share.high, '#4dabf7')}</td>
            <td><b>${esc(r.label)}</b><div class="muted">${r.snr.toFixed(0)} dB</div></td></tr>`;
        }).join('')}</table>`);
      this.changed();
    } catch (e) {
      out('❌ ' + esc(e.message || String(e)));
    } finally {
      if (mic?.recorder) try { mic.recorder.stop(); } catch {}
      this.calibrating = false; $('#checkBtn').disabled = false; $('#calibBtn').disabled = false;
    }
  },

  async calibrate() {
    if (this.calibrating) return;
    const out = (h) => ($('#calibOut').innerHTML = h);
    const micId = $('#calibMic').value;
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (!devs.length) return toast('还没有在线的播放设备');
    const client = micId === 'self' ? null : [...this.link?.clients.values() || []].find((c) => c.did === micId);
    if (micId !== 'self' && !client) return toast('选的录音设备不在线');
    this.calibrating = true; $('#calibBtn').disabled = true;
    let recorder = null;
    try {
      // 1) 先打开麦克风（第一次会弹出权限询问）
      out('🎙 打开麦克风中…（如果弹出权限询问，请点“允许”）');
      if (micId === 'self') {
        const ctx = this.selfEngine?.ctx || (this.calCtx ||= new (window.AudioContext || window.webkitAudioContext)());
        recorder = new MicRecorder(ctx, hostNow);
        await recorder.start();
      } else {
        this.link.send(client, { t: 'micPrep' });
        const r = await this.waitFor(micId, 30000);
        if (!r || r.t !== 'micReady') throw new Error(r?.msg ? '录音设备无法使用麦克风：' + r.msg : '录音设备没有回应（请在那台手机上允许麦克风）');
      }
      // 2) 安排每台设备轮流“啾”3 轮
      const gap = 900, rounds = 3, n = devs.length, T0 = hostNow() + 1200;
      const slots = [];
      for (let r = 0; r < rounds; r++) devs.forEach((d, i) => slots.push({ did: d.id, at: T0 + (r * n + i) * gap }));
      for (const d of devs) {
        const at = slots.filter((x) => x.did === d.id).map((x) => x.at);
        if (d.id === 'self') { this.selfEngine.duck(at[at.length - 1] + 1200); at.forEach((t) => this.selfEngine.playChirpAt(t)); }
        else for (const c of this.link.clients.values()) if (c.did === d.id) this.link.send(c, { t: 'chirp', at, until: slots[slots.length - 1].at + 1200 });
      }
      const end = slots[slots.length - 1].at + 900;
      out(`🔊 校准中，请保持安静…（约 ${Math.ceil((end - hostNow()) / 1000)} 秒）`);
      let results;
      if (recorder) {
        await sleep(end - hostNow());
        out('🧮 分析录音中…');
        await sleep(30);
        results = detectChirps(recorder.stop(), slots);
        recorder = null;
      } else {
        this.link.send(client, { t: 'measure', end, slots });
        const r = await this.waitFor(micId, end - hostNow() + 20000);
        if (!r || r.t !== 'measureResult') throw new Error('录音设备没有返回结果');
        results = r.results;
      }
      // 3) 计算每台设备的偏差（取中位数），以所有设备的中位数为基准对齐
      const rows = devs.map((d) => {
        const ok = results.filter((x) => x.did === d.id && x.ok).map((x) => x.err);
        // 3 次结果要互相吻合（相差 15ms 以内）才算数，防止把别的声音误认成“啾”
        const med = ok.length >= 2 ? median(ok) : null;
        const agree = ok.filter((e) => med !== null && Math.abs(e - med) < 15).length;
        return { d, n: agree, med: agree >= 2 ? med : null };
      });
      const valid = rows.filter((r) => r.med !== null);
      if (!valid.length) throw new Error('没有录到清楚的“啾”声：把录音设备放近一点、把音量调大、保持安静再试');
      const ref = median(valid.map((r) => r.med));
      this.calUndo = Object.fromEntries(devs.map((d) => [d.id, d.latencyMs]));
      for (const r of valid) r.d.latencyMs = Math.max(-1000, Math.min(1000, Math.round(r.d.latencyMs - (r.med - ref))));
      out(`✅ 校准完成（每台设备取 3 次中位数）：<table class="small" style="width:100%;margin-top:6px">${rows.map((r) => `<tr><td>${esc(r.d.name)}</td><td>${r.med === null ? `<span style="color:var(--bad)">没听清（${r.n}/3）</span>` : `${r.med - ref > 0 ? '晚' : '早'} ${Math.abs(r.med - ref).toFixed(0)} ms`}</td><td>${r.med === null ? '未调整' : `微调 → ${r.d.latencyMs} ms`}</td></tr>`).join('')}</table>`);
      $('#calibUndo').hidden = false;
      this.changed();
    } catch (e) {
      out('❌ ' + esc(e.message || String(e)));
    } finally {
      if (recorder) try { recorder.stop(); } catch {}
      this.calibrating = false; $('#calibBtn').disabled = false;
    }
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

  animMotion() {
    const dot = document.getElementById('motionDot');
    if (!dot || H.motion.y === 'off') return;
    const th = (motionAngle(H.motion, hostNow()) * Math.PI) / 180, R = Math.min(2.2, H.listener.y * 0.8, H.size.w / 2 - 0.05);
    const x = (H.listener.x + Math.sin(th) * R) * 100, y = (H.listener.y - Math.cos(th) * R) * 100;
    dot.setAttribute('transform', `translate(${x},${y})`);
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
    $('#pcPlay').checked = H.pcPlay !== false;
    $('#liveStems').checked = !!H.liveStems;
    const clients = [...this.link?.clients.values() || []].filter((c) => c.did);
    const opusN = clients.filter((c) => c.opus && H.opus).length;
    const dropped = clients.reduce((a, c) => a + (c.dropped || 0), 0);
    const lagTxt = this.live.running && this.lagShown !== undefined ? ` · 电脑处理延迟 ${Math.round(this.lagShown)} ms` : '';
    const surf = { browser: '标签页 ✅', window: '窗口 ⚠️', monitor: '整个屏幕 ⚠️' }[this.live.surface] || '未知';
    $('#liveStatus').textContent = on
      ? `${H.liveStems ? (this.sep ? '🎚 拆声部中 · ' : '🎚 拆声部（等待分工模式） · ') : ''}共享类型：${surf}${lagTxt}${this.live.surface !== 'browser' ? '（电脑原声不会静音，手机会比电脑晚）' : ''} · 正在采集 · 已发送 ${this.live.stats.chunks} 段 · ${opusN} 台用 Opus 压缩、${clients.length - opusN} 台用无损 PCM${dropped ? ` · 网络丢弃 ${dropped} 段` : ''}`
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
    const { w, h } = H.size;
    // 画布越小，图标和文字按比例缩小（桌面模式下 1 米多的画布也能摆得开）
    const k = Math.max(0.16, Math.min(1, Math.max(w / 8, h / 5)));
    const fs = (px) => `font-size:${(px * k).toFixed(2)}px`;
    const pad = 40 * k;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${w * U + pad * 2} ${h * U + pad * 2}`);
    svg.replaceChildren();
    svg.append(el('rect', { class: 'room', x: 0, y: 0, width: w * U, height: h * U, rx: 8 * k }));
    const fine = Math.max(w, h) <= 3, step = fine ? 0.1 : 1;
    const grid = el('g', { class: 'grid' });
    const cls = (i) => (fine && i % 5 === 0 ? 'major' : ''); // 桌面模式：每 50cm 一条粗线
    for (let i = 1; i * step < w - 1e-6; i++) grid.append(el('line', { x1: i * step * U, y1: 0, x2: i * step * U, y2: h * U, class: cls(i) }));
    for (let i = 1; i * step < h - 1e-6; i++) grid.append(el('line', { x1: 0, y1: i * step * U, x2: w * U, y2: i * step * U, class: cls(i) }));
    svg.append(grid);
    svg.append(el('text', { x: (w * U) / 2, y: -14 * k, 'text-anchor': 'middle', class: 'sub', style: fs(12) },
      `▲ 前方   （网格 ${fine ? '10 厘米' : '1 米'}，${fine ? '桌面' : '房间'} ${w}×${h} 米）`));
    const L = H.listener, devs = Object.values(H.devices);
    for (const d of devs) if (d.online) svg.append(el('line', { class: 'link', x1: L.x * U, y1: L.y * U, x2: d.x * U, y2: d.y * U, 'stroke-dasharray': `${6 * k} ${6 * k}` }));
    const lg = el('g', { class: 'listener', 'data-drag': 'listener', transform: `translate(${L.x * U},${L.y * U})` });
    lg.append(el('circle', { r: 30 * k, fill: '#ffd43b22', stroke: '#ffd43b', 'stroke-width': 2 }));
    lg.append(el('text', { 'text-anchor': 'middle', y: 9 * k, style: fs(26) }, '👑'));
    lg.append(el('text', { 'text-anchor': 'middle', y: 50 * k, class: 'sub', style: fs(12) }, '听众位'));
    svg.append(lg);
    if (H.motion.y !== 'off') {
      const md = el('g', { id: 'motionDot' });
      md.append(el('circle', { r: 22 * k, fill: '#cc5de855', stroke: '#cc5de8', 'stroke-width': 2 }));
      md.append(el('text', { 'text-anchor': 'middle', y: 8 * k, style: fs(22) }, '🔊'));
      svg.append(md);
    }
    for (const d of devs) {
      const plan = plans[d.id], r = 28 * k;
      const g = el('g', { class: `dev ${d.online ? '' : 'offline'} ${this.selected === d.id ? 'selected' : ''}`, 'data-drag': 'dev', 'data-id': d.id, transform: `translate(${d.x * U},${d.y * U})` });
      g.append(el('circle', { class: 'ring', r: r + 6 * k }));
      if (plan) g.append(el('circle', { r: r + (2 + plan.gain * 14) * k, fill: d.color + '22', stroke: 'none' }));
      g.append(el('circle', { class: 'body', r, fill: d.color, stroke: '#0008', 'stroke-width': 2 }));
      g.append(el('text', { 'text-anchor': 'middle', y: 9 * k, style: fs(24) }, d.muted ? '🔇' : TYPE_ICON[d.type]));
      g.append(el('text', { 'text-anchor': 'middle', y: r + 22 * k, style: fs(15) }, d.name));
      let sub = d.online ? '' : '离线';
      if (plan) {
        const parts = [`${Math.round(plan.gain * 100)}%`];
        const D = plan.delayMs + d.latencyMs;
        if (Math.abs(D) >= 0.05) parts.push(`${D > 0 ? '+' : ''}${D.toFixed(1)}ms`);
        if (H.mode === 'split') {
          const a = plan.assign.map((x) => assignLabel(H, x).replace(/^声道 /, '')).join('+') || '无';
          parts.push(a.length > 18 ? a.slice(0, 17) + '…' : a);
        } else if (H.options.stereo) parts.push(plan.pan < -0.2 ? '偏左' : plan.pan > 0.2 ? '偏右' : '居中');
        if (d.override?.locked) parts.push('🔒');
        sub = parts.join(' · ');
        if (this.checkRes?.[d.id]) sub += `  🎙${this.checkRes[d.id].label}`;
      }
      g.append(el('text', { 'text-anchor': 'middle', y: r + 40 * k, class: 'sub', style: fs(12) }, sub));
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
    setVal('#gainPreset', H.gainPreset);
    setVal('#motionType', H.motion.y); setVal('#motionSpeed', H.motion.p); setVal('#motionDepth', H.motion.d);
    $('#motionSpeedVal').textContent = `${H.motion.p} 秒/圈`;
    $('#motionDepthVal').textContent = `${Math.round(H.motion.d * 100)}%`;
    $('#motionOpts').style.display = H.motion.y === 'off' ? 'none' : ''; setVal('#splitPreset', H.splitPreset); setVal('#width', H.stereoWidth);
    setVal('#lowCut', H.bands.lowCut); setVal('#highCut', H.bands.highCut);
    setVal('#roomW', H.size.w); setVal('#roomH', H.size.h); setVal('#master', H.masterVolume);
    $('#masterVal').textContent = Math.round(H.masterVolume * 100) + '%';
    $('#splitBox').style.display = H.mode === 'split' ? '' : 'none';
    $('#deskMode').textContent = Math.max(H.size.w, H.size.h) > 3 ? '🪑 切换到桌面模式' : '🏠 切回房间模式';
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
    const micSig = online.map((d) => d.id + d.name).join('|');
    if (micSig !== this.micSig) {
      this.micSig = micSig;
      const sel = $('#calibMic'), cur = sel.value;
      sel.innerHTML = '<option value="self">这台电脑的麦克风</option>' + online.filter((d) => d.id !== 'self').map((d) => `<option value="${esc(d.id)}">${esc(d.name)} 的麦克风</option>`).join('');
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    }
    $('#devCount').textContent = `${online.length} 在线`;
    $('#noDev').style.display = devs.length ? 'none' : '';
    $('#clearOffline').hidden = !devs.some((d) => !d.online);
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
      if (s.hidden) badges.push(s.bg ? '<span class="badge warn">在后台（后台播放模式）</span>' : '<span class="badge bad">⚠️ 切到后台/锁屏了</span>');
      else if (s.bg) badges.push('<span class="badge">后台播放模式</span>');
      if (s.via === 'backup') badges.push('<span class="badge">备用通道</span>');
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
  const R = Math.min(2.5, H.listener.y * 0.85, H.size.w / 2 - 0.05);
  return {
    x: Math.min(H.size.w, Math.max(0, H.listener.x + Math.sin(a) * R)),
    y: Math.min(H.size.h, Math.max(0, H.listener.y - Math.cos(a) * R)),
  };
}

const decodeLy = (cur) => cur.ly || null;
function decodeWire(w, did) {
  if (!w || w.v !== 1) return null;
  const g = w.g && { id: w.g.id, kind: w.g.k, name: w.g.n, loop: !!w.g.l, duration: w.g.d, tracks: w.g.t.map(([src, ch]) => ({ src, channels: ch })) };
  const pb = { status: PB_NAME[w.pb[0]], S: w.pb[1], o: w.pb[2] };
  const p = w.p[did];
  const base = { group: g, pb, mode: w.m, ld: w.ld, ly: w.ly, mo: w.mo };
  if (!p || !g) return { ...base, plan: null };
  const [gain, posDelay, latency, srcs, label, color, name, az] = p;
  return {
    ...base,
    plan: {
      gain, posDelay, latency, D: posDelay + latency, label, color, name, az,
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
    // 设备编号按浏览器保存：同一台手机重新打开/重新扫码，还是同一台设备（位置、校准结果都沿用）
    this.did = store.get('sm-did', null) || rid(8);
    store.set('sm-did', this.did);
    this.name = $('#name').value.trim() || `${TYPE_NAME[detectDeviceType()]} ${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
    store.set('sm-name', this.name);
    this.engine = new Engine(this.clock, { fetchFile: (id) => this.fetchFile(id) });
    window.smNode = this;
    try { await this.engine.unlock(); } catch { this.engine.error = '无法启用声音，请再点一次页面'; }
    this.keepAwake();
    if (store.get('sm-bg', false)) this.engine.setBackgroundMode(true).catch(() => store.set('sm-bg', false));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.keepAwake(); this.sendStats(); });
    $('#overlay').remove();
    this.engine.addEventListener('status', () => this.render());
    this.decoder = new LiveDecoder(this.engine.ctx, (ts, buf, src) => this.engine.pushLive(ts, buf, src));
    if (!window.Peer) { this.err = '连接库没加载出来，检查网络后刷新'; return this.render(); }
    const opus = await opusDecodeSupported();
    this.link = new AutoNodeLink(code, () => ({ t: 'hello', did: this.did, name: this.name, type: detectDeviceType(), opus }));
    this.link.addEventListener('status', (e) => {
      const s = e.detail;
      this.linkStatus = s === 'open' && this.link.via === 'backup' ? '已连接控制端（备用通道）' : { open: '已连接控制端', connecting: '连接中…', fallback: '主通道连不上，正在改走备用通道…', lost: '连接断开，重连中…', 'no-host': '找不到这个房间（控制端没打开或房间码不对），重试中…', 'signal-error': '连不上信令服务器，重试中…' }[s] || s;
      if (s === 'open') { this.clock.reset(); this.burst(16); for (const f of this.files.values()) if (!f.done) this.link.send({ t: 'getFile', id: f.id }); }
      this.render();
    });
    this.link.addEventListener('msg', (e) => this.onMsg(e.detail));
    this.link.addEventListener('bin', (e) => this.onBin(e.detail));
    setInterval(() => this.burst(5), 10000);
    setInterval(() => this.sendStats(), 2000);
    setInterval(() => this.render(), 500);
    setInterval(() => this.renderLyrics(), 150);
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
    } else if (m.t === 'lyrics') {
      this.lyrics = m.ly;
    } else if (m.t === 'chirp' && Array.isArray(m.at)) {
      if (m.until) this.engine.duck(m.until);
      m.at.forEach((t) => this.engine.playChirpAt(t));
    } else if (m.t === 'micPrep') {
      (async () => {
        try {
          this.rec = new MicRecorder(this.engine.ctx, () => this.clock.now());
          await this.rec.start();
          this.link.send({ t: 'micReady' });
        } catch (e) { this.rec = null; this.link.send({ t: 'micErr', msg: e.message || String(e) }); }
      })();
    } else if (m.t === 'measure' && this.rec) {
      (async () => {
        await sleep(Math.max(0, m.end - this.clock.now()));
        const rec = this.rec; this.rec = null;
        const data = rec.stop();
        const results = m.kind === 'spectrum'
          ? analyzeWindows(data, m.windows, m.noise)
          : detectChirps(data, m.slots).map((r) => ({ did: r.did, err: r.err, ok: r.ok }));
        this.link.send({ t: 'measureResult', results });
      })();
    } else if (m.t === 'solo') {
      this.engine.solo(m.from, m.to, m.end);
    } else if (m.t === 'fileErr') {
      const f = this.files.get(m.id);
      if (f && !f.done) { f.reject(new Error('控制端找不到这个文件（控制端刷新后需要重新添加）')); this.files.delete(m.id); }
    }
  },

  onBin({ hdr, payload }) {
    if (hdr.k === 'l') {
      const ch = hdr.ch || 2, src = hdr.s || 'live';
      try { hdr.c === 'o' ? this.decoder.opus(hdr.ts, payload, ch, src) : this.decoder.pcm(hdr.ts, payload, hdr.sr || 48000, ch, src); } catch {}
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
        hidden: document.visibilityState !== 'visible', awake: !!this.wake, via: this.link.via, bg: !!e.bgMode,
        ready: li.loaded === li.needed, loading: li.loaded < li.needed, dl: this.dlPercent(),
        live: isLive ? { got: e.liveStats.got, late: e.liveStats.late } : null,
        error: e.error ? String(e.error).slice(0, 100) : null,
      },
    });
  },

  setSelf(patch) { this.link?.send({ t: 'self', ...patch }); },

  // 屏幕常亮：锁屏/熄屏后浏览器会暂停声音，所以播放时一直亮着
  async keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !this.wake) {
        this.wake = await navigator.wakeLock.request('screen');
        this.wake.addEventListener('release', () => { this.wake = null; this.render(); });
      }
    } catch { this.wake = null; }
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: 'SoundMesh 联动音响', artist: `房间 ${this.code}` }); } catch {}
    }
    this.render();
  },

  renderLyrics() {
    const L = this.lyrics, ly = this.cur && decodeLy(this.cur);
    if (!L || !ly || ly.id !== L.id) { $('#nodeLyric').hidden = true; return; }
    const pos = songPos(this.clock.now(), this.cur, ly);
    const idx = lineAt(L.lines, pos);
    renderLyricStrip($('#nodeLyric'), L.synced ? L.lines : null, idx, this.cur.group?.kind === 'live' && ly.a == null ? '等控制端对准歌词…' : '');
  },

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
      ['屏幕常亮', this.wake ? '✅ 已开启' : 'wakeLock' in navigator ? '⚠️ 未开启（点一下页面任意位置）' : '⚠️ 这个浏览器不支持，请在系统设置里把自动锁屏时间调长'],
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
  // 点页面任意位置：重新申请屏幕常亮、恢复声音（浏览器要求由点击触发）
  $('#nodeMain').addEventListener('click', () => { if (node.engine) { node.keepAwake(); node.engine.ctx.resume().catch(() => {}); } });
}

// 可以“添加到主屏幕”当 App 用；也能在网络不稳时更快打开
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
$('#lat').oninput = (e) => { $('#latVal').textContent = `${e.target.value} ms`; node.setSelf({ latencyMs: Number(e.target.value) }); };
$('#rename').onclick = async () => {
  const v = await ask('设备名称', { input: node.name });
  if (v && v.trim()) { node.name = v.trim().slice(0, 24); store.set('sm-name', node.name); node.setSelf({ name: node.name }); }
};
$('#testBeep').onclick = () => node.engine?.beep();
$('#bgMode').checked = store.get('sm-bg', false);
$('#bgMode').onchange = async (e) => {
  const on = e.target.checked;
  store.set('sm-bg', on);
  if (!node.engine) return;
  try { await node.engine.setBackgroundMode(on); toast(on ? '已开启后台播放：可以切到别的应用了。延迟可能变了，建议重新做一次自动校准' : '已关闭后台播放'); }
  catch { e.target.checked = false; store.set('sm-bg', false); toast('这个浏览器不允许后台播放'); }
  node.sendStats();
};
