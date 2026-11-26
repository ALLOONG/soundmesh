// SoundMesh 独立网页版：控制端 + 播放节点；设备之间 WebRTC 直连；支持电脑实时音源
import { computeMix, assignLabel, assignOptions, guessRole, capOf, BAND_PARTS } from './mix.js';
import { Engine, motionAngle } from './engine.js';
import { BUILTIN_GROUPS } from './synth.js';
import { MultiHostLink, AutoNodeLink, packBin } from './transport.js';
import { LiveCapture, LiveDecoder, opusDecodeSupported, pcmEncode, StreamEncoder, VideoMirror } from './live.js';
import { Separator, STEMS, STEM_NAMES } from './separator.js';
import { searchLyrics, parseLRC, lineAt } from './lyrics.js';
import { MicRecorder, makeCode, findCodes, detectChirps, median, robustMean, analyzeWindows, toRate, alignMusic, findEarlyCopy, analyzeResponse, profileFromBands, SWEEP_SEC } from './calib.js';

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
  if (stems) for (const st of STEMS) tracks.push({ id: 'lv-' + st, name: STEM_NAMES[st], src: 'live:' + st, channels: 2, duration: 0, role: st });
  tracks.push({ id: 'lv-band', name: '乐团角色（每台设备专属）', src: 'live:band', channels: 2, duration: 0, role: 'band' });
  return { id: 'live', name: window.SoundMeshApp ? '手机实时音源（YouTube Music / Spotify…）' : '电脑实时音源（YouTube / Spotify…）', kind: 'live', loop: false, duration: 0, tracks };
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
    library: [], currentGroupId: 'demo-mix', liveDelay: 350, autoDelay: true, opus: true, quality: 'lossless', pcPlay: true, liveStems: false, mirrorOffset: 0, videoMode: false, lyrics: null, ly: { a: null, s: 0, o: 0 }, motion: { y: 'off', p: 8, d: 0.85, t0: 0 },
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
  // 音质默认用最好的（无损），不自动切换；想省流量时自己在“音质”里改
  if (!saved?.v3) { H.quality = 'lossless'; H.opus = false; H.v3 = true; }
  if (H.quality === 'auto') H.quality = 'lossless';
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
  dg: { chunks: 0, maxGap: 0, lastChunkAt: 0, sent: 0, log: [] },

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
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (e.source === window && d && d.__soundmesh === 'tabStream' && d.id) this.startTabFromExt(d.id, d.title);
    });
    window.smHost = this; window.smH = H; // 调试用
    // 诊断记录：每秒一条，保留 2 分钟
    setInterval(() => {
      const dg = this.dg, clients = [...this.link?.clients.values() || []].filter((c) => c.did);
      dg.log.push({
        t: new Date().toTimeString().slice(0, 8), vis: document.visibilityState[0], foc: document.hasFocus() ? 1 : 0,
        cap: this.live.running ? 1 : 0, chunks: dg.chunks, gap: Math.round(dg.maxGap), sent: dg.sent, sil: dg.silent || 0, pk: Math.round((dg.peak || 0) * 100),
        lag: this.lagShown === undefined ? null : Math.round(this.lagShown), ld: H.liveDelay, ctx: this.live.ctx?.state?.[0] || '-',
        buf: clients.map((c) => Math.round(this.link.buffered(c) / 1024)),
        floor: this.delayFloor ?? null,
        dev: Object.values(H.devices).filter((d) => d.online && d.id !== 'self').map((d) => {
          const s = d.stats || {}, c = clients.find((x) => x.did === d.id), pl = this.plans()[d.id];
          return [d.name.slice(0, 8), s.live?.got ?? null, s.live?.late ?? null, s.live?.res ?? s.drifts ?? null, s.rtt ?? null, s.jitter ?? null, s.out ?? null, s.hidden ? 1 : 0, s.via === 'backup' ? 'B' : 'P',
            pl ? Math.round(this.totalD(d)) : null, c ? (this.opusFor(c) ? 'Opus' : 'PCM') : '-', s.live?.concealed ?? 0];
        }),
      });
      dg.chunks = 0; dg.maxGap = 0; dg.sent = 0; dg.silent = 0; dg.peak = 0;
      if (dg.log.length > 120) dg.log.shift();
    }, 1000);
    $('#diagBtn').onclick = () => {
      const head = `SoundMesh 诊断 ${new Date().toLocaleString()} 采集方式=${this.live.mode || '-'} UA=${navigator.userAgent}\n音质=${H.quality} 列：时间 vis(v/h) foc 采集 每秒片段 最大间隔ms 每秒发送 静音片段数 音量峰值 处理延迟 缓冲ms 最低缓冲 音频状态 发送队列KB 设备[名,收到,迟到,重新对齐,往返,抖动,输出延迟,后台,通道,延迟微调D,编码,补偿次数]\n`;
      const txt = head + this.dg.log.map((r) => [r.t, r.vis, r.foc, r.cap, r.chunks, r.gap, r.sent, `静音${r.sil}`, `峰值${r.pk}`, r.lag, r.ld, r.floor, r.ctx, JSON.stringify(r.buf), JSON.stringify(r.dev)].join(' ')).join('\n');
      $('#diagOut').hidden = false; $('#diagOut').value = txt;
      navigator.clipboard?.writeText(txt).then(() => toast('诊断记录已复制，直接粘贴给 Claude 就行'), () => toast('自动复制失败：请在下面的框里全选后复制'));
    };
    // （不再因为控制端切到后台就加大缓冲：采集改为排队读取后不会丢声音，真来不及时由“处理延迟”检测自动加大）
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
      if (H.autoDelay && !this.calibrating && this.live.running && msg.stats?.hidden && !wasHidden && H.liveDelay < 1500) {
        H.liveDelay = 1500; this.lastBump = Date.now();
        toast(`${H.devices[c.did].name} 切到后台了，缓冲自动加到 1500 ms（可以打开“同步画面”让画面也跟着延后）`);
        this.changed();
      }
      // 自动调节：某台设备的音频分段开始“迟到”（来不及播），就把缓冲加大一点
      // （校准中和刚结束的 5 秒不算：那是校准串流切换、分析录音时卡的那一下，不是网络或设备跟不上）
      const late = msg.stats?.live?.late;
      if (H.autoDelay && !this.calibrating && Date.now() - (this.calEndAt || 0) > 5000 && this.live.running && Number.isFinite(late) && Number.isFinite(prevLate) && late > prevLate + 2 && H.liveDelay < 3000) {
        this.safeFloor = Math.max(this.safeFloor || 0, H.liveDelay + 20); this.safeUntil = Date.now() + 180000; // 记住：3 分钟内别再压到这么低
        H.liveDelay = Math.min(3000, H.liveDelay + (H.videoMode ? 30 : 250)); // 看视频模式只回加一点点
        this.lastBump = Date.now();
        toast(`${H.devices[c.did].name} 有卡顿，缓冲自动加到 ${H.liveDelay} ms`);
        this.changed();
      }
      this.renderSoon();
    } else if (msg.t === 'chirpAck' && c.did) {
      (this.chirpAcks ||= {})[c.did] = msg;
    } else if (msg.t === 'self' && H.devices[c.did]) {
      const d = H.devices[c.did];
      if (typeof msg.name === 'string' && msg.name.trim()) d.name = msg.name.trim().slice(0, 24);
      if (Number.isFinite(msg.latencyMs)) d.latencyMs = Math.max(-1000, Math.min(1000, msg.latencyMs));
      this.changed();
    } else if (msg.t === 'getFile') this.sendFile(c, String(msg.id));
    else if (msg.t === 'recPart' && c.did) { ((this.recParts ||= {})[c.did] ||= [])[msg.i] = msg.b64; }
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
  useOpus() { return (H.quality || (H.opus ? 'high' : 'lossless')) !== 'lossless'; },
  // 这台设备现在用不用 Opus：自动模式下网络好用无损，这台设备网络跟不上时才临时换 Opus 320
  opusFor(c) { return !!c.opus && (H.quality === 'auto' ? !!c.autoOpus : this.useOpus()); },
  // 每秒检查一次各设备的网络（自动音质用）：排队数据太多 / 有丢弃 / 设备那边迟到变多 → 换 Opus；稳定 60 秒后再试无损
  checkLinks() {
    if (H.quality !== 'auto') return;
    const now = performance.now();
    for (const c of this.link?.clients.values() || []) {
      if (!c.did || !c.opus) continue;
      const d = H.devices[c.did], dropped = c.dropped || 0;
      // 只看网络本身（发送排队、被丢弃）；“迟到”是缓冲不够，由自动缓冲处理，不是换编码能解决的
      const bad = this.link.buffered(c) > 48 * 1024 || dropped > (c.lastDropped ?? dropped);
      c.lastDropped = dropped;
      if (bad) { if (!c.autoOpus) toast(`📶 ${d?.name || '设备'} 的网络跟不上无损，暂时改用 Opus 320（几乎听不出差别）`); c.autoOpus = true; c.autoSince = now; }
      else if (c.autoOpus && now - c.autoSince > 60000) { c.autoOpus = false; } // 稳定一分钟：再试无损
    }
  },
  needs(did, src) { return !!this.need[did]?.has(src); },
  anyNeeds(src) { return Object.values(this.need).some((set) => set.has(src)); },
  onLiveChunk({ frame, ts, l, r }) {
    if (this.calGen) return; // 校准中：串流内容由校准音产生器接管
    this.lastLiveTs = ts;
    const pn = performance.now();
    if (this.dg.lastChunkAt) this.dg.maxGap = Math.max(this.dg.maxGap, pn - this.dg.lastChunkAt);
    this.dg.lastChunkAt = pn; this.dg.chunks++;
    // 声音内容：这一段是不是几乎没声（音源本身卡住时会出现一串静音段）
    let pk = 0;
    for (let i = 0; i < l.length; i += 4) { const v = Math.abs(l[i]) + Math.abs(r[i]); if (v > pk) pk = v; }
    if (pk < 0.001) this.dg.silent++;
    this.dg.peak = Math.max(this.dg.peak || 0, pk);
    // 暂停检测：连续 60ms 完全没声（说明音源暂停了）→ 立刻通知所有设备静音；有声音了再恢复
    if (pk < 0.0005) {
      if (++this.silentRun === 3 && !this.hushed && H.currentGroupId === 'live') {
        this.hushed = true;
        this.link?.broadcast({ t: 'hush', on: true });
        this.selfEngine?.hush(true);
      }
    } else {
      this.silentRun = 0;
      if (this.hushed) {
        this.hushed = false;
        this.link?.broadcast({ t: 'hush', on: false, at: ts });
        this.selfEngine?.hush(false, ts);
      }
    }
    if (H.currentGroupId !== 'live') return;
    // 电脑自己处理慢了多少：这段声音采集完到现在过了多久（玩游戏/最小化时 CPU 被抢走会变大）
    const lag = hostNow() - (ts + 20);
    // 校准刚结束的 3 秒：电脑在分析录音时卡的那一下会让这几段晚到，不代表平常跟不上，不列入
    if (Date.now() - (this.calEndAt || 0) > 3000) this.lagMax = Math.max(this.lagMax || 0, lag);
    const now = Date.now();
    if (now - (this.lagWin || 0) > 2000) {
      this.lagShown = this.lagMax; this.lagMax = 0; this.lagWin = now;
      // 处理延迟已经吃掉大部分缓冲 → 自动加大（留 150ms 给网络和手机）
      const margin = H.videoMode ? 25 : 150; // 看视频模式：只给网络和手机留 25ms
      // 校准刚结束的 3 秒内不算（音乐刚接回来、校准分析时卡的那一下不代表电脑跟不上）
      if (H.autoDelay && !this.calibrating && Date.now() - (this.calEndAt || 0) > 3000 && this.lagShown + margin > H.liveDelay && H.liveDelay < 3000) {
        H.liveDelay = Math.min(3000, Math.ceil((this.lagShown + margin + 30) / 10) * 10);
        this.lastBump = now;
        toast(`电脑处理跟不上（慢了 ${Math.round(this.lagShown)} ms），缓冲自动加到 ${H.liveDelay} ms`);
        this.changed();
      }
    }
    this.dispatch('live', ts, [l, r]);
    // 留最近 15 秒的原声（单声道），“用音乐校准”时拿来和录音比对
    { const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) * 0.5;
      const ring = this.srcRing || (this.srcRing = []); ring.push({ ts, x: m }); while (ring.length && ts - ring[0].ts > 15000) ring.shift(); }
    // 拆声部：只有当有设备需要某个声部时才运行
    const needBand = this.anyNeeds('live:band');
    if ((H.liveStems && STEMS.some((st) => this.anyNeeds('live:' + st))) || needBand) {
      this.sep = this.sep || new Separator(48000, 960);
      for (const o of this.sep.push(frame, l, r)) {
        const ts2 = this.live.tsOf(o.frame);
        if (H.liveStems) for (const st of STEMS) if (this.anyNeeds('live:' + st)) this.dispatch('live:' + st, ts2, o.stems[st]);
        if (needBand) this.dispatchBand(ts2, o.stems);
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
      if (this.opusFor(c) && this.encoderFor(src, planes.length).ok) { wantOpus = true; continue; }
      // 网络跟不上：排队的数据已经超过约半秒（之后的声音反正会迟到）→ 丢这一段，让网络先缓过来
      if (this.link.buffered(c) > 96 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; }
      pcm = pcm || pcmEncode(planes);
      if (this.link.sendBin(c, packBin({ k: 'l', ts, c: 'p', sr: 48000, ch: planes.length, s: src }, pcm))) this.dg.sent++;
    }
    if (wantOpus) this.encoderFor(src, planes.length).encode(ts, planes);
  },
  // 乐团模式：按每台设备的角色把四个声部混成一份专属立体声，分别发给它
  dispatchBand(ts, stems) {
    const pm = this.plans(), mixFor = (did) => {
      const w = pm[did]?.band; if (!w) return null;
      const n = stems.vocals[0].length, L = new Float32Array(n), R = new Float32Array(n);
      for (const st of STEMS) { const [al, ar] = w.lr?.[st] || [w[st] || 0, w[st] || 0]; if (!al && !ar) continue; const [sl, sr] = stems[st]; for (let i = 0; i < n; i++) { L[i] += al * sl[i]; R[i] += ar * sr[i]; } }
      return [L, R];
    };
    if (this.selfEngine && this.needs('self', 'live:band')) {
      const planes = mixFor('self');
      if (planes) { const buf = this.selfEngine.ctx.createBuffer(2, planes[0].length, 48000); planes.forEach((p, i) => buf.copyToChannel(p, i)); this.selfEngine.pushLive(ts, buf, 'live:band'); }
    }
    for (const c of this.link?.clients.values() || []) {
      if (!c.did || !this.needs(c.did, 'live:band')) continue;
      const planes = mixFor(c.did); if (!planes) continue;
      if (this.opusFor(c)) { const e = this.encoderFor('live:band|' + c.did, 2, c); e.only = c; e.encode(ts, planes); continue; }
      if (this.link.buffered(c) > 96 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; }
      if (this.link.sendBin(c, packBin({ k: 'l', ts, c: 'p', sr: 48000, ch: 2, s: 'live:band' }, pcmEncode(planes)))) this.dg.sent++;
    }
  },
  encoderFor(src, ch, only = null) {
    let e = this.encoders.get(src);
    if (!e) {
      const wire = only ? 'live:band' : src; // 专属编码器（乐团模式）只发给那一台设备
      e = new StreamEncoder(ch, (ts, data) => {
        for (const c of only ? [e.only] : this.link?.clients.values() || []) {
          if (!c.did || !this.opusFor(c) || !this.needs(c.did, wire)) continue;
          if (this.link.buffered(c) > 24 * 1024) { c.dropped = (c.dropped || 0) + 1; continue; }
          if (this.link.sendBin(c, packBin({ k: 'l', ts, c: 'o', ch, s: wire }, data))) this.dg.sent++;
        }
      }, H.quality === 'standard' ? 'standard' : 'high');
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
  // 画面延迟 = 缓冲延迟 + 各设备平均位置延迟 + 手动微调
  mirrorDelay() {
    const pcOut = ((this.selfEngine?.ctx || this.calCtx)?.outputLatency || 0) * 1000;
    // 校准过：每台设备“排定的延迟 + 实测的真实延迟”就是它真正出声的时刻（校准后各设备都一样），取中间值
    const pm = this.plans(), arrive = Object.values(H.devices).filter((d) => d.online && Number.isFinite(d.realLat) && pm[d.id])
      .map((d) => (pm[d.id].delayMs || 0) + (d.latencyMs || 0) + d.realLat);
    if (arrive.length) return Math.max(0, H.liveDelay + median(arrive) - pcOut + (H.mirrorOffset || 0));
    const plans = Object.values(pm);
    const avgD = plans.length ? plans.reduce((a, p) => a + p.delayMs, 0) / plans.length : 0;
    const avgLat = Object.values(H.devices).filter((d) => d.online).reduce((a, d, _, arr) => a + d.latencyMs / arr.length, 0);
    // 校准测到的“真实到达比预定晚多少”，再减去电脑本身播放 YouTube 时的输出延迟（YouTube 画面是按那个时间对齐的）
    const real = Number.isFinite(H.avBase) ? H.avBase : 0;
    return Math.max(0, H.liveDelay + avgD + avgLat + real - pcOut + (H.mirrorOffset || 0));
  },
  toggleMirror(on) {
    if (on === undefined) on = $('#mirrorBox').hidden;
    if (on) {
      if (!VideoMirror.supported()) return toast('这个浏览器不支持同步画面，请用电脑版 Chrome 或 Edge');
      if (!this.live.running || !this.live.videoTrack) return toast('先开始共享电脑声音（共享时会一起拿到画面）');
      this.mirror = this.mirror || new VideoMirror($('#mirror'), () => this.mirrorDelay());
      this.live.setVideoActive(true);
      this.mirror.start(this.live.videoTrack);
      $('#mirrorBox').hidden = false;
      // 一键直接全屏（按 Esc 退出全屏，画面窗口还在）
      $('#mirrorBox').requestFullscreen?.().catch(() => {});
    } else {
      this.mirror?.stop();
      this.live.setVideoActive(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      $('#mirrorBox').hidden = true;
    }
  },
  resetLivePipeline() {
    this.sep = null;
    for (const e of this.encoders.values()) e.close();
    this.encoders.clear();
  },
  onLiveState(on) {
    if (this.hushed) { this.hushed = false; this.link?.broadcast({ t: 'hush', on: false }); this.selfEngine?.hush(false); }
    this.silentRun = 0;
    this.resetLivePipeline(); // 每次开始/停止共享都从干净的状态开始
    if (!on && this.mirror) this.toggleMirror(false);
    else if (on && !$('#mirrorBox').hidden) this.toggleMirror(true);
    if (on) { H.currentGroupId = 'live'; H.playback = { status: 'playing', startServerTime: hostNow(), startOffset: 0 }; }
    else if (H.currentGroupId === 'live') H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 };
    this.updateOpusWant();
    this.libSig = null;
    this.changed();
  },
  // 扩展送来的分页声音（在 YouTube 分页点扩展图标 →「把这个分页的声音送到 SoundMesh」）
  async startTabFromExt(id, title) {
    const autoSelf = !this.selfEngine && H.pcPlay !== false;
    if (autoSelf) this.toggleSelf();
    try {
      await this.live.startFromTabId(id);
      toast(`🎞️ 已经开始播放「${(title || '分页').slice(0, 40)}」的声音（由扩展抓取，不会出现共享提示条）`);
    } catch (e) {
      if (autoSelf && this.selfEngine) this.toggleSelf();
      toast('扩展抓声音失败：' + (e.message || e.name || e));
    }
  },
  async toggleLive() {
    if (this.live.running) return this.live.stop();
    // 必须在这次点击里先启用本机声音（浏览器要求声音由点击触发）；
    // 共享的是标签页时电脑原声会被静音，电脑就改为和手机一起同步出声
    const autoSelf = !this.selfEngine && H.pcPlay !== false;
    if (autoSelf) this.toggleSelf();
    try {
      if (window.SoundMeshApp) {
        // Android App：抓手机上其他 App 的声音。原 App 会在这台手机上照常出声（比其他设备早），所以这台先不跟着出声
        if (autoSelf && this.selfEngine) this.toggleSelf();
        await this.live.startFromAndroid();
        return;
      }
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
      v: 1, ep: EPOCH, ld: H.liveDelay, mo: H.motion.y !== 'off' ? { y: H.motion.y, p: H.motion.p, d: H.motion.d, t0: H.motion.t0 } : null, ly: H.lyrics ? { id: H.lyrics.id, a: H.ly.a, s: H.ly.s, o: H.ly.o } : null, pb: [PB_CODE[pb.status], Math.round(pb.startServerTime), r3(pb.startOffset)], m: H.mode === 'split' ? 1 : H.mode === 'band' ? 2 : 0,
      g: g ? { id: g.id, k: g.kind, n: g.name.slice(0, 60), l: g.loop ? 1 : 0, d: r3(g.duration || 0), t: g.tracks.map((t) => [t.src, t.channels]) } : null,
      p: {},
    };
    for (const [did, pl] of Object.entries(plans)) {
      const d = H.devices[did];
      const idx = (id) => g.tracks.findIndex((t) => t.id === id);
      w.p[did] = [r3(pl.gain), r1(pl.delayMs), d.latencyMs,
        pl.sources.map((s) => [idx(s.trackId), s.mix.type === 'lr' ? ['l', r3(s.mix.wl), r3(s.mix.wr)] : s.mix.type === 'ch' ? ['c', s.mix.index] : ['s'], s.filters.map((f) => [f.type[0], Math.round(f.freq)])]),
        (pl.band ? this.bandLabel(pl.band) : H.mode === 'split' ? pl.assign.map((k) => assignLabel(H, k)).join(' + ') : '协同播放').slice(0, 60), d.color, d.name, Math.round(pl.azimuth)];
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
    if (H.liveDelay !== this.prevLd) { this.prevLd = H.liveDelay; this.ldChangedAt = Date.now(); }
    this.checkLinks();
    const g = this.group();
    if (H.playback.status === 'playing' && g && g.kind !== 'live' && !g.loop && this.position() > g.duration + 0.5) {
      H.playback = { status: 'stopped', startServerTime: 0, startOffset: 0 };
      this.changed();
    }
    if (Date.now() - (this.lastFull || 0) > 3000) { this.lastFull = Date.now(); this.lastWire = ''; this.publish(); } // 定期重发，防丢
    // 自动调节：一段时间没有设备卡顿，就把缓冲往下压，慢慢找到最低又不卡的值。
    // 看视频模式更积极：6 秒没卡就降 20ms，最低 80ms（声音只比画面晚一点点）
    const anyHidden = Object.values(H.devices).some((d) => d.online && d.stats?.hidden);
    // 下限：每台设备需要的最少缓冲 = 它被要求“提前播”的量（延迟微调为负数时）+ 它的扬声器延迟
    //        + 电脑最近 1 分钟最慢的处理延迟 + 网络和处理余量。取所有在线设备里最大的那个。
    const now0 = Date.now();
    this.lagHist = (this.lagHist || []).filter((x) => now0 - x.t < 60000);
    if (Number.isFinite(this.lagShown)) this.lagHist.push({ t: now0, v: this.lagShown });
    const sepLag = (H.liveStems || H.mode === 'band') && this.group()?.kind === 'live' ? 70 : 0; // 拆声部要多等约 64ms
    const lagMax = Math.max(30, ...this.lagHist.map((x) => x.v)) + sepLag;
    const plansNow = this.plans();
    let need = 0, needBy = null;
    for (const d of Object.values(H.devices)) {
      if (!d.online || d.id === 'self') continue;
      const D = this.totalD(d, plansNow);
      const v = Math.max(0, -D) + (d.stats?.out || 0) + lagMax + (d.stats?.rtt || 10) / 2 + (H.videoMode ? 25 : 60);
      if (v > need) { need = v; needBy = d; }
    }
    // 最近 3 分钟内有设备卡顿过：卡顿时的缓冲 + 20ms 就是新的下限（不再反复往下压到会卡的程度）
    const learned = this.safeUntil > now0 ? this.safeFloor || 0 : 0;
    const floor = Math.ceil(Math.max(H.videoMode ? 40 : 100, need, learned) / 10) * 10;
    this.delayFloor = floor; this.delayFloorBy = needBy;
    // 下限比现在的缓冲还高（比如刚改了延迟微调）：直接提上去，不等卡顿
    if (H.autoDelay && !this.calibrating && this.live.running && H.liveDelay < floor) { H.liveDelay = floor; this.changed(); }
    const calm = H.videoMode ? 6000 : 20000, every = H.videoMode ? 4000 : 10000;
    if (H.autoDelay && !this.calibrating && this.live.running && H.liveDelay > floor && !anyHidden) {
      const now = Date.now();
      this.lastBump = this.lastBump || now;
      this.lastLower = this.lastLower || now;
      if (!this.calibrating && now - this.lastBump > calm && now - this.lastLower > every) {
        this.lastLower = now;
        H.liveDelay = Math.max(floor, H.liveDelay - (H.videoMode ? 10 : 20)); // 小步下调，设备用微调速度平滑跟上，不会断
        this.changed();
      }
    }
    // 给「SoundMesh 画面延后」扩展：把画面该延后多少告诉它（它在 YouTube 页面里把画面往后推）
    try { window.postMessage({ __soundmesh: 'videoDelay', ms: Math.round(this.mirrorDelay()), live: !!this.live?.running, t: Date.now() }, location.origin); } catch {}
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
    if (this.hushed) { this.hushed = false; this.link?.broadcast({ t: 'hush', on: false }); this.selfEngine?.hush(false); }
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
    $('#mirrorBtn').onclick = () => this.toggleMirror();
    $('#videoMode').onchange = (e) => {
      H.videoMode = e.target.checked;
      if (H.videoMode) {
        H.autoDelay = true;
        if (H.liveDelay > 200) H.liveDelay = 200; // 先直接降到 200ms，再自动往下找
        this.lastBump = Date.now() - 6000; this.lastLower = 0;
        if (H.liveStems) toast('提示：看视频模式下建议关掉“实时拆声部”，它会多出约 70ms 延迟');
      }
      this.changed();
    };
    $('#mirrorClose').onclick = () => this.toggleMirror(false);
    $('#mirrorFull').onclick = () => $('#mirrorBox').requestFullscreen?.().catch(() => toast('无法全屏'));
    $('#mirrorOffset').oninput = (e) => { H.mirrorOffset = Number(e.target.value); this.changed(); };
    $('#pcPlay').onchange = (e) => {
      H.pcPlay = e.target.checked;
      // 正在共享时立刻生效
      if (this.live.running && !H.pcPlay && this.selfEngine) this.toggleSelf();
      else if (this.live.running && H.pcPlay && !this.selfEngine && this.live.surface === 'browser') this.toggleSelf();
      this.changed();
    };
    $('#quality').onchange = (e) => {
      H.quality = e.target.value; H.opus = H.quality !== 'lossless';
      for (const enc of this.encoders?.values() || []) enc.close(); // 换音质：编码器按新码率重建
      this.encoders?.clear();
      this.updateOpusWant(); this.changed();
    };
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
    $('#calibBtn').onclick = () => this.smartCalibrate();
    $('#alignTestBtn') && ($('#alignTestBtn').onclick = () => this.alignTest());
    $('#micDev').onchange = (e) => { try { localStorage.setItem('sm-mic', e.target.value); } catch {} };
    $('#micDevRefresh').onclick = () => this.listMics(true);
    $('#calibMic').addEventListener('change', () => { $('#micDevRow').style.display = $('#micDevHint').style.display = $('#calibMic').value === 'self' ? '' : 'none'; });
    this.listMics(false);
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.listMics(false));
    $('#profileBtn').onclick = () => this.profileDevices();
    $('#bandGlue').oninput = (e) => { H.bandGlue = Number(e.target.value) / 100; $('#bandGlueVal').textContent = e.target.value + '%'; this.changed(); };
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
      const recorder = new MicRecorder(ctx, hostNow, this.micDevice());
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

  // 校准前：缓冲刚调整过的话，等设备跟上（最多 4 秒），否则量到的是“正在移动中”的设备
  async settle(out) {
    const t = Date.now() - (this.ldChangedAt || 0);
    if (t < 3500) { out?.('⏳ 等缓冲稳定…'); await sleep(Math.min(4000, 3500 - t)); }
  },

  // 让每台设备轮流“啾”rounds 轮，返回每台设备相对“应有时刻”的误差（毫秒）
  async measureChirps(devs, micId, rounds, out, label, raw = false) {
    this.chirpAcks ||= {};
    await this.settle(out);
    let recorder = null;
    try {
      let client = null;
      if (micId === 'self') {
        const ctx = this.selfEngine?.ctx || (this.calCtx ||= new (window.AudioContext || window.webkitAudioContext)());
        recorder = new MicRecorder(ctx, hostNow, this.micDevice()); await recorder.start();
      } else ({ client } = await this.openMic(micId));
      const gap = 800, n = devs.length, T0 = hostNow() + 1200;
      const slots = [];
      for (let r = 0; r < rounds; r++) devs.forEach((d, i) => slots.push({ did: d.id, at: T0 + (r * n + i) * gap }));
      const until = slots[slots.length - 1].at + 1200;
      for (const d of devs) {
        const at = slots.filter((x) => x.did === d.id).map((x) => x.at);
        if (d.id === 'self') { this.selfEngine.duck(until); this.chirpAcks.self = { played: at.filter((t) => this.selfEngine.playChirpAt(t, raw)).length, total: at.length }; }
        else for (const c of this.link.clients.values()) if (c.did === d.id) this.link.send(c, { t: 'chirp', at, until, raw });
      }
      const end = slots[slots.length - 1].at + 800;
      out(`🔊 ${label}，请保持安静…（约 ${Math.ceil((end - hostNow()) / 1000)} 秒）`);
      let results;
      if (recorder) {
        await sleep(end - hostNow()); await sleep(30);
        results = detectChirps(recorder.stop(), slots); recorder = null;
      } else {
        this.link.send(client, { t: 'measure', end, slots });
        const r = await this.waitFor(micId, end - hostNow() + 20000);
        if (!r || r.t !== 'measureResult') throw new Error('录音设备没有返回结果');
        results = r.results;
      }
      return devs.map((d) => {
        const v = results.filter((x) => x.did === d.id && x.ok).map((x) => x.err);
        const med = median(v), agree = v.filter((e) => med !== null && Math.abs(e - med) < 2);
        const ok = agree.length >= Math.ceil(rounds / 2);
        return { d, n: agree.length, of: rounds, val: ok ? robustMean(agree) : null, spread: ok && agree.length > 1 ? Math.max(...agree) - Math.min(...agree) : null };
      });
    } finally {
      if (recorder) try { recorder.stop(); } catch {}
    }
  },

  // 某台设备“没听清”的原因
  chirpWhy(d) {
    const a = this.chirpAcks?.[d.id];
    if (!a) return '没有回应：这台设备可能断线了，或者还是旧版本（请刷新它的页面）';
    if (!a.unlocked || a.state !== 'running') return '它的声音被系统暂停了：在那台设备上点一下屏幕，确认有“正在出声”，再校准';
    if (a.hidden) return '它的 SoundMesh 在后台：切回前台、亮着屏幕再校准';
    if (a.played < a.total) return `测试音只播出 ${a.played}/${a.total} 次：那台设备可能太忙或时间还没对准，过几秒再试`;
    return '测试音播了，但录音设备没听清：把它的系统音量调大一点、或把录音设备放近一点、周围安静一点';
  },

  // 设备特长：测过就用测的；没测过按设备类型估（手机小喇叭低音最少，电脑/平板好一些）
  capOf(d) { return capOf(d); },
  // “🎤 人声 45% · 🎹 伴奏 30%”：这台设备在乐团里主要负责什么
  bandLabel(w) {
    const parts = Object.entries(w).filter(([k]) => BAND_PARTS[k]);
    const tot = parts.reduce((a, [, b]) => a + b, 0) || 1;
    return parts.sort((a, b) => b[1] - a[1]).filter(([, v], i) => i === 0 || v / tot > 0.15).slice(0, 3).map(([k, v]) => `${BAND_PARTS[k]} ${Math.round((v / tot) * 100)}%`).join(' · ');
  },

  // 测各设备特长：每台轮流播 2 秒扫频（从低到高），录音后算出能放多低、多高
  async profileDevices() {
    if (this.calibrating) return;
    const out = (h) => ($('#bandOut').innerHTML = h);
    const micId = $('#calibMic').value;
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (!devs.length) return toast('还没有在线的播放设备');
    this.calibrating = true; $('#profileBtn').disabled = true;
    let recorder = null;
    try {
      out('🎙 打开麦克风中…（录音设备用“校准与检查”里选的那台，放在你坐的位置）');
      const mic = await this.openMic(micId); recorder = mic.recorder;
      const T0 = hostNow() + 900, STEP = SWEEP_SEC * 1000 + 900;
      const noise = { from: T0 + 100, to: T0 + 800 };
      const windows = devs.map((d, i) => ({ did: d.id, at: T0 + 1000 + i * STEP }));
      const end = windows[windows.length - 1].at + STEP;
      for (const w of windows) {
        if (w.did === 'self') { this.selfEngine.duck(end); this.selfEngine.playSweepAt(w.at); }
        else for (const c of this.link.clients.values()) if (c.did === w.did) this.link.send(c, { t: 'sweep', at: w.at, until: end });
      }
      out(`🔊 各设备轮流播放从低到高的扫频音，请保持安静…（约 ${Math.ceil((end - hostNow()) / 1000)} 秒）`);
      let res;
      if (recorder) { await sleep(end - hostNow()); await sleep(30); res = analyzeResponse(recorder.stop(), windows, noise); recorder = null; }
      else {
        this.link.send(mic.client, { t: 'measure', kind: 'response', end, windows, noise });
        const r = await this.waitFor(micId, end - hostNow() + 20000);
        if (!r || r.t !== 'measureResult') throw new Error('录音设备没有返回结果');
        res = r.results;
      }
      const rows = res.map((r) => { const d = H.devices[r.did], p = profileFromBands(r.bands); if (d && p) d.cap = p; return { d, p }; });
      out(`✅ 测好了：<table class="small" style="width:100%;margin-top:4px">${rows.map(({ d, p }) => `<tr><td>${esc(d?.name || '?')}</td><td>${p ? `低音到 <b>${p.low} Hz</b> · 高音到 <b>${(p.high / 1000).toFixed(0)} kHz</b>` : '<span style="color:var(--bad)">没听清（音量调大一点再试）</span>'}</td></tr>`).join('')}</table><div class="muted">低音数字越小 = 低音越足。乐团模式会自动按这个分配角色。</div>`);
      this.changed();
    } catch (e) {
      out('❌ ' + esc(e.message || String(e)));
    } finally {
      if (recorder) try { recorder.stop(); } catch {}
      this.calibrating = false; $('#profileBtn').disabled = false;
    }
  },

  // 这台电脑用哪个麦克风录音（存在本机，不跟着房间走）
  micDevice() { try { return localStorage.getItem('sm-mic') || ''; } catch { return ''; } },
  // 列出电脑上的麦克风；浏览器要先允许过一次麦克风才看得到名字（ask = true 时会请求一次）
  async listMics(ask) {
    try {
      let list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      if (ask && list.every((d) => !d.label)) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop());
        list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      }
      const sel = $('#micDev'), cur = this.micDevice();
      sel.innerHTML = '<option value="">系统默认麦克风</option>' + list.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `麦克风 ${i + 1}（按 🔄 显示名称）`)}</option>`).join('');
      sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
    } catch (e) { if (ask) toast('没办法读取麦克风列表：' + (e.message || e.name)); }
  },

  // 一台设备排定的总延迟（按位置的延迟 + 延迟微调），和设备那边 plan.D 一样
  totalD(d, pm = this.plans()) { return (pm[d.id]?.delayMs || 0) + (d.latencyMs || 0); },

  // 取原声：控制端时间 tsFrom 开始、rate 采样率下 n 个采样点（缺的地方补 0）
  srcExcerpt(tsFrom, n, rate) {
    const ring = this.srcRing || [];
    if (!ring.length) return null;
    const durMs = (n / rate) * 1000 + 5, m = Math.ceil((durMs / 1000) * 48000) + 4, out = new Float32Array(m);
    let any = false;
    for (const c of ring) {
      if (c.ts + 20 < tsFrom || c.ts > tsFrom + durMs) continue;
      const off = Math.round(((c.ts - tsFrom) / 1000) * 48000);
      for (let i = 0; i < c.x.length; i++) { const j = off + i; if (j >= 0 && j < m) { out[j] = c.x[i]; any = true; } }
    }
    if (!any) return null;
    return toRate(out, 48000, rate).subarray(0, n);
  },

  // 一轮“用音乐测量”：各设备轮流单独出声，录音后和原声比对，返回每台设备“听到时刻 - 原声时间 - 缓冲”（毫秒）
  async musicPass(devs, micId, search, out, label) {
    const rate = 24000, pm = this.plans();
    const known = (d) => (Number.isFinite(d.realLat) ? d.realLat : 0);
    await this.settle(out);
    const mic = await this.openMic(micId); // 先把麦克风打开（手机可能要一两秒），再安排各设备的出声时段
    const LEN = 2600, GAP = 300, T0 = hostNow() + 1000; // 每台 2.6 秒：切三段各自比对，每段要够长才稳
    const wins = devs.map((d, i) => {
      const from = T0 + i * (LEN + GAP), to = from + LEN, k = known(d);
      return { d, did: d.id, from, to, a: from + k + 300, b: to + k - 60, expect: H.liveDelay + this.totalD(d, pm) + k };
    });
    // 最后 1.6 秒所有设备都静音：这时如果还录到同一首歌，就一定不是 SoundMesh 放的（通常是电脑自己在放原声）
    const maxK = Math.max(0, ...devs.map(known)), quietFrom = wins[wins.length - 1].to + 300, quietTo = quietFrom + 1600 + maxK;
    const end = quietTo + 200;
    for (const w of wins) {
      if (w.did === 'self') this.selfEngine.solo(w.from, w.to, end);
      else for (const c of this.link.clients.values()) if (c.did === w.did) this.link.send(c, { t: 'solo', from: w.from, to: w.to, end });
    }
    out(`🎵 ${label}：各设备轮流单独放音乐，请保持安静…（约 ${Math.ceil((end - hostNow()) / 1000)} 秒）`);
    let data = await this.recordUntil(mic, micId, end + 300);
    data = { ...data, rec: toRate(data.rec, data.sr, rate) };
    out('🧮 比对中…'); await sleep(30);
    const get = (t, n, rr) => this.srcExcerpt(t, n, rr);
    const res = alignMusic(data, wins, get, rate, search);
    window.__smLastMusic = res.map((r) => ({ ...r })); // 排查用
    window.__smMusicHist = [...(window.__smMusicHist || []).slice(-9), { search, res: window.__smLastMusic }];
    window.__smLastRaw = { startHost: data.startHost, n: data.rec.length, head: Array.from(data.rec.subarray(24000, 24400)) }; // 排查用
    // 全部静音的那段：还听得到同一首歌 → 有不受 SoundMesh 控制的声音（电脑原声等）
    const ec = findEarlyCopy(data, quietFrom + 500 + maxK, quietTo - 50, 0, 700, (t, n, rr) => this.srcExcerpt(t, n, rr), rate);
    this.earlyCopy = ec && ec.found ? ec.lagMs : null;
    return res.map((r, i) => ({ ...r, d: wins[i].d, val: r.ok ? r.offset - H.liveDelay : null }));
  },

  // 用正在播的音乐校准：测的就是音乐真正走的路线，最贴近实际听感
  async musicCalibrate() {
    if (this.calibrating) return;
    const out = (h) => ($('#calibOut').innerHTML = h);
    if (this.group()?.kind !== 'live' || !this.live.running) return toast('先开始共享电脑声音，并放一首一直有声音的歌（不要选安静的前奏），再按这个');
    const micId = $('#calibMic').value;
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (!devs.length) return toast('还没有在线的播放设备');
    // 音乐有固定节拍，搜索范围太大可能对到“差一拍”的位置：没校准过的设备先用“啾”声粗测，音乐只在很小的范围里精确对齐
    let chirped = false;
    if (devs.some((d) => !Number.isFinite(d.realLat))) {
      chirped = true;
      out('先用“啾”声粗测一次各设备的延迟…');
      await this.calibrate({ rounds: 3, verify: false });
      if (devs.some((d) => !Number.isFinite(d.realLat))) return; // 粗测没成功（结果已经显示了原因）
    }
    this.calibPrep();
    this.calibrating = true; for (const b of ['#calibBtn', '#musicCalBtn', '#checkBtn']) $(b) && ($(b).disabled = true);
    const r1 = (v) => Math.round(v * 10) / 10;
    try {
      out('🎙 打开麦克风中…（如果弹出权限询问，请点“允许”）');
      // 第 1 步：用音乐测出每台设备实际出声的时刻。一律在 ±400ms 的大范围里找：
      // 如果只在小范围找，而真正的位置刚好在范围外，长音/重复节奏的“假峰”就会被当成答案；
      // 大范围里真正的峰会远远高过假峰，再加上“独一无二”和三段吻合的检查，不会对错
      // 第 1 步：每台设备至少测两次，两次相差 1ms 以内才算数（不一致就再加测一次，取吻合的那两次）。
      // 要准不要快：宁可多花十几秒，也不要用一次碰巧的结果
      const measure = async (tag) => {
        const passes = [];
        passes.push(await this.musicPass(devs, micId, 400, out, `第 1 步：测量${tag}（1/2）`));
        passes.push(await this.musicPass(devs, micId, 400, out, `第 1 步：测量${tag}（2/2）`));
        const settle = () => devs.map((d, i) => {
          const all = passes.map((p) => p[i]), last = all[all.length - 1];
          const vals = all.filter((r) => r.ok).map((r) => r.val), m = median(vals);
          const close = vals.filter((v) => m !== null && Math.abs(v - m) < 1);
          const ok = close.length >= 2;
          const best = all.filter((r) => r.ok).sort((x, y) => y.clarity - x.clarity)[0] || last;
          return { ...best, d, ok, quiet: all.every((r) => r.quiet), val: ok ? close.reduce((a2, v) => a2 + v, 0) / close.length : null, nOk: vals.length, spread: close.length > 1 ? Math.max(...close) - Math.min(...close) : null };
        });
        let rs = settle();
        if (rs.some((r) => !r.ok && r.nOk >= 1)) { passes.push(await this.musicPass(devs, micId, 400, out, `第 1 步：两次结果不一致，加测一次`)); rs = settle(); }
        return rs;
      };
      let rows = await measure('');
      let lost = rows.filter((r) => !r.ok && !r.quiet).map((r) => r.d);
      // 还是找不到：改用“啾”声只给这几台重新粗测，再用音乐精确对齐
      if (lost.length) {
        const ch = await this.measureChirps(lost, micId, 3, out, `${lost.map((d) => d.name).join('、')} 的延迟好像变了，用“啾”声重新粗测`, true);
        const pc = this.plans();
        for (const r of ch) if (r.val !== null) r.d.realLat = r1(r.val - (pc[r.d.id]?.delayMs || 0)); // “啾”声不套用延迟微调，量到的就是真实延迟
        if (ch.some((r) => r.val !== null)) rows = await measure('（重测）');
      }
      const pm = this.plans(), good = rows.filter((r) => r.ok);
      if (!good.length) {
        // 音乐比对都没成功：保留“啾”声的结果（已经校准好了），并列出每台的情况方便排查
        out(`⚠️ 音乐比对没成功，${chirped ? '已保留刚才“啾”声校准的结果（各设备已经对齐，只是没有再用音乐精修）' : '各设备的设置没有改动'}。
          <table class="small" style="width:100%;margin-top:6px">${rows.map((r) => `<tr><td>${esc(r.d.name)}</td><td class="muted">录到的音量 ${r.levelDb ?? '?'} dB · 比对清晰度 ${r.clarity ? r.clarity.toFixed(1) : '?'}${r.near !== undefined ? ` · 三段吻合 ${r.near}/3` : ''}</td></tr>`).join('')}</table>
          <div class="muted">清晰度 9 以上才算对上，7 以下代表录到的声音和原曲完全对不起来。常见原因：录到的音量太小（低于 -60 dB：把喇叭音量调大、麦克风靠近一点）；歌里安静的段落太多（换一首一直有声音的）；电脑自己也在放原声。截图给我也可以帮你看。</div>`);
        return;
      }
      this.calUndo = Object.fromEntries(devs.map((d) => [d.id, d.latencyMs]));
      for (const r of good) r.real = r.val - this.totalD(r.d, pm); // 这台设备真实的延迟（浏览器不知道的那部分）
      // 让每台设备在你的位置同时出声：以最慢的为准，其他设备等它（微调都 ≥ 0）
      const C = Math.max(...good.map((r) => (pm[r.d.id]?.delayMs || 0) + r.real));
      for (const r of good) {
        const nl = Math.max(0, Math.min(1000, r1(C - (pm[r.d.id]?.delayMs || 0) - r.real)));
        r.change = nl - r.d.latencyMs; r.d.realLat = r1(r.real); r.d.latencyMs = nl;
      }
      this.changed(); this.lastWire = ''; this.publish();
      // 第 2 步：一定验证。套用新设置后再用音乐测一次；还有设备差超过 0.3ms 就修正，再验证，最多 3 次
      if (good.length >= 2) {
        for (let it = 1; it <= 3; it++) {
          await sleep(2500); // 等新设置生效、设备追上
          const chk = await this.musicPass(good.map((r) => r.d), micId, 25, out, `第 2 步：验证（第 ${it} 次）`);
          const cg = chk.filter((r) => r.ok);
          if (cg.length < 2) break;
          const mid = median(cg.map((x) => x.val));
          let bad = 0;
          for (const r of good) r.fixed = false;
          for (const c of cg) {
            const row = good.find((r) => r.d === c.d);
            row.resid = c.val - mid; row.verifyRounds = it;
            if (Math.abs(row.resid) > 0.3 && Math.abs(row.resid) < 30) { c.d.latencyMs = r1(c.d.latencyMs - row.resid); row.fixed = true; bad++; }
          }
          if (!bad) break;
          this.changed(); this.lastWire = ''; this.publish();
        }
      }
      const minLat = Math.min(...good.map((r) => r.d.latencyMs));
      if (minLat < 0) for (const r of good) r.d.latencyMs = r1(r.d.latencyMs - minLat);
      const verified = rows.filter((r) => r.resid !== undefined && !r.fixed);
      const worst = Math.max(0, ...verified.map((r) => Math.abs(r.resid)));
      const others = rows.filter((r) => r.other && r.other.ratio > 0.6 && Math.abs(r.other.ms) > 3);
      const pcCopy = this.earlyCopy;
      out(`✅ 用音乐校准完成${verified.length ? `：播放音乐时各设备之间误差 <b>${worst < 0.3 ? '0.3 ms 以内' : worst.toFixed(1) + ' ms'}</b>` : ''}${rows.some((r) => r.fixed) ? '（验证 3 次后个别设备仍有小误差，已修正；想再确认可以再按一次）' : ''}
        <table class="small" style="width:100%;margin-top:6px">${rows.map((r) => `<tr><td>${esc(r.d.name)}</td>
          <td>${r.ok ? `真实延迟 ${r.real.toFixed(1)} ms${r.spread !== null && r.spread !== undefined ? `<div class="muted">两次测量相差 ${r.spread.toFixed(2)} ms</div>` : ''}` : `<span style="color:var(--bad)">没比对成功</span><div class="muted">${r.quiet ? '这段时间几乎没声音：换一段一直有声音的歌' : this.chirpWhy(r.d).replace('测试音', '音乐')}</div>`}</td>
          <td>${r.resid === undefined ? (r.ok ? '验证没比对成功' : '未调整') : `校准后 ${Math.abs(r.resid) < 0.3 ? '✅' : '🔧'} ${r.resid >= 0 ? '+' : ''}${r.resid.toFixed(1)} ms`}</td>
          <td class="muted">微调 → ${r.d.latencyMs} ms</td></tr>`).join('')}</table>
        ${pcCopy !== null && pcCopy !== undefined ? `<div style="color:var(--bad);margin-top:6px">⚠️ <b>还听到一份不经过 SoundMesh 的同一首歌</b>（几乎没有延迟，比所有设备早了好几百毫秒）。这通常是<b>电脑自己在放原声</b>：共享“整个屏幕”时电脑不会静音。它会和其他设备形成回音，校准也救不了——请改成共享 YouTube Music 那个<b>分页</b>（会自动静音），或把电脑的系统音量关掉。</div>` : ''}
        ${others.length ? `<div style="color:var(--warn,#f59f00);margin-top:4px">⚠️ 在 ${others.map((r) => esc(r.d.name)).join('、')} 单独出声的时候，还听到另一份同样的音乐（${others.map((r) => `${r.other.ms < 0 ? '早' : '晚'} ${Math.abs(r.other.ms).toFixed(0)} ms`).join('、')}）。通常是<b>电脑本身还在放原声</b>（共享整个屏幕时会这样）或有其他设备在放同一首歌——它不受 SoundMesh 控制，会听起来像回音。建议改成共享 YouTube 那个分页，或把电脑音量关掉。</div>` : ''}`);
      $('#calibUndo').hidden = false;
      this.changed();
    } catch (e) {
      out('❌ ' + esc(e.message || String(e)));
    } finally {
      this.calibrating = false; for (const b of ['#calibBtn', '#musicCalBtn', '#checkBtn']) $(b) && ($(b).disabled = false);
    }
  },

  // ================= 校准（重新设计）=================
  // 原理：把“啾”声直接放进实时串流里，跟音乐走完全一样的路（编码、网络、播放缓冲、延迟微调、喇叭），
  // 各设备轮流出声、同一个麦克风录下来，只比较“各设备彼此之间”谁早谁晚——不需要知道任何一台的绝对延迟，
  // 也不依赖任何延迟公式。按差多少直接调整微调，再量一次确认；没对齐就继续修，直到全部在 0.5ms 以内（闭环）。

  // 校准音产生器：接管 live 串流，每 20ms 产生一段，只有排到的那台设备的那一段才有“啾”声，其余是静音
  calStreamStart(devs, sched = [], codeFn = null) {
    this.calStreamStop();
    const FR = 960;
    const live = (did) => [...(this.need[did] || [])].filter((x) => x === 'live' || x.startsWith('live:'));
    const gen = { next: hostNow() - 20, byDid: {} };
    gen.setSched = (sc) => { gen.byDid = {}; for (const c of sc) (gen.byDid[c.did] ||= []).push(c.ts); };
    gen.setSched(sched);
    const codes = Object.fromEntries(devs.map((d, i) => [d.id, codeFn ? codeFn(i, d) : makeCode(i, 48000)]));
    this.calGen = gen;
    // 串流原本在暂停（静音）中，设备会把声音淡出：先叫它们恢复
    this.link?.broadcast({ t: 'hush', on: false, at: gen.next }); this.selfEngine?.hush(false, gen.next); this.hushed = false; this.silentRun = 0;
    const emit = (ts) => {
      for (const d of devs) {
        const L = new Float32Array(FR), list = gen.byDid[d.id] || [], chirp = codes[d.id] || codes[Object.keys(codes)[0]], CN = chirp.length;
        for (const c0 of list) {
          const off = Math.round(((c0 - ts) / 1000) * 48000); // 啾声第 0 个采样点在这一段的位置
          if (off >= FR || off + CN <= 0) continue;
          for (let i = Math.max(0, off); i < Math.min(FR, off + CN); i++) L[i] += chirp[i - off] * 0.5;
        }
        const planes = [L, L.slice()], srcs = live(d.id);
        for (const src of srcs.length ? srcs : ['live']) {
          if (d.id === 'self') {
            if (!this.selfEngine) continue;
            const buf = this.selfEngine.ctx.createBuffer(2, FR, 48000); buf.copyToChannel(planes[0], 0); buf.copyToChannel(planes[1], 1);
            this.selfEngine.pushLive(ts, buf, src);
          } else for (const c of this.link?.clients.values() || []) if (c.did === d.id) this.link.sendBin(c, packBin({ k: 'l', ts, c: 'p', sr: 48000, ch: 2, s: src }, pcmEncode(planes)));
        }
      }
    };
    // 提前 400ms 送出：控制端偶尔卡一下（分析录音、回收内存）也不会让设备断音（设备有缓冲，早到没关系）
    gen.timer = setInterval(() => { let k = 0; while (this.calGen === gen && gen.next <= hostNow() + 400 && k++ < 40) { emit(gen.next); gen.next += 20; } }, 10);
  },
  calStreamStop() { if (this.calGen) { clearInterval(this.calGen.timer); this.calGen = null; this.calEndAt = Date.now(); this.lagMax = 0; this.lagWin = Date.now(); this.lagShown = 0; this.lagHist = []; } },

  // 录音到控制端时间 end 为止（本机麦克风或其他设备的麦克风），返回 { rec, sr, startHost, inLat }
  async recordUntil(mic, micId, end) {
    let data;
    if (mic.recorder) {
      await sleep(end - hostNow());
      const r = mic.recorder.stop(); data = { rec: r.rec, sr: r.sr, startHost: r.startHost, inLat: r.inLat || 0 };
    } else {
      this.recParts = {}; this.recParts[micId] = [];
      this.link.send(mic.client, { t: 'measure', kind: 'raw', end });
      const r = await this.waitFor(micId, end - hostNow() + 30000);
      if (!r || r.t !== 'measureResult' || !r.raw) throw new Error('录音设备没有返回录音（请确认它已经刷新到新版本）');
      const parts = this.recParts[micId] || [];
      if (parts.length < r.raw.n || parts.some((p) => !p)) throw new Error('录音没有完整传回来，请再试一次');
      const bins = parts.map((p) => atob(p)), total = bins.reduce((a, b) => a + b.length, 0), u8 = new Uint8Array(total);
      { let o = 0; for (const b of bins) { for (let i = 0; i < b.length; i++) u8[o + i] = b.charCodeAt(i); o += b.length; } }
      const pcm = new Int16Array(u8.buffer, 0, u8.length >> 1), x = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) x[i] = pcm[i] / 32768;
      data = { rec: x, sr: r.raw.rate || 24000, startHost: r.raw.startHost, inLat: r.raw.inLat || 0 };
    }
    if (window.__smFakeMicAsync) data = await window.__smFakeMicAsync(data); // 自动测试用
    return data;
  },

  // 量一轮：每台设备出声 reps 次（轮流、间隔 1 秒），返回每台“听到时刻 - 串流时间”（毫秒，只有彼此相比才有意义）
  async measureStream(devs, micId, reps, out, label) {
    await this.settle(out);
    const mic = await this.openMic(micId);
    const ld = H.liveDelay, GAP = 1500; // 1.5 秒一次：指纹 + 房间回音约 0.45 秒，各设备延迟差到 0.7 秒也不会互相重叠
    // 每次出声的时间加上随机偏移：其他设备的声音就不会刚好排成和这台一样的节奏，被误认成这台（离麦克风近的设备可能大声十倍）
    const T0 = hostNow() + 600, sched = [];
    for (let r = 0; r < reps; r++) devs.forEach((d, i) => sched.push({ did: d.id, d, ts: T0 + (r * devs.length + i) * GAP + Math.random() * 300 }));
    // 不猜每台什么时候会被听到：在“缓冲 - 0.3 秒”到“缓冲 + 1.8 秒”之间全部搜索（涵盖任何延迟微调和蓝牙延迟）
    const lo = ld - 300, hi = ld + 1800;
    const end = Math.max(...sched.map((x) => x.ts)) + hi + 250;
    out(`🔊 ${label}：各设备轮流发出校准音（每台 ${reps} 次），请保持安静、不要移动设备…（约 ${Math.ceil((end - hostNow()) / 1000)} 秒）`);
    let data;
    this.calGen.setSched(sched);
    try { data = await this.recordUntil(mic, micId, end); }
    finally { this.calGen?.setSched([]); }
    out('🧮 分析中…'); await sleep(30);
    if (data.sr > 24000) data = { ...data, rec: toRate(data.rec, data.sr, 24000), sr: 24000 }; // 24kHz 分析就够（指纹只到 9kHz），计算量减半
    const plans = devs.map((d, i) => ({ did: d.id, idx: i, ts: sched.filter((x) => x.did === d.id).map((x) => x.ts) }));
    const res = findCodes(data, plans, lo, hi);
    window.__smLastStream = res; window.__smStreamHist = [...(window.__smStreamHist || []).slice(-9), res]; // 排查用
    return devs.map((d, i) => {
      const f = res[i], heardR = f.reps.filter((x) => x.val !== null && x.ratio > 6);
      const vals = heardR.map((x) => x.val), m = median(vals);
      const close = vals.filter((v) => m !== null && Math.abs(v - m) <= 1);
      // 4 次里至少 3 次互相吻合（1ms 内），而且梳状匹配的峰要明显、独一无二
      const good = close.length >= Math.max(2, Math.ceil(reps * 0.75)) && f.clarity > 4 && f.unique < 0.8;
      // 粗略值：梳状匹配很明确、但 4 次不够一致时（例如和别台的声音重叠），先拿来做第一次粗调，之后几轮再精修
      const rough = !good && heardR.length >= 2 && f.clarity > 8 && f.unique < 0.6 ? m : null;
      return { d, ok: good, rough, val: good ? close.reduce((a, v) => a + v, 0) / close.length : null, heard: heardR.length, of: reps, spread: close.length > 1 ? Math.max(...close) - Math.min(...close) : null, clarity: f.clarity, unique: f.unique, ratio: Math.max(0, ...f.reps.map((x) => x.ratio)) };
    });
  },

  async streamCalibrate() {
    if (this.calibrating) return;
    const out = (h) => ($('#calibOut').innerHTML = h);
    if (H.currentGroupId !== 'live') return this.calibrate(); // 不是实时音源：用原本的“啾”声校准
    const micId = $('#calibMic').value;
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (!devs.length) return toast('还没有在线的播放设备');
    if (micId !== 'self' && ![...this.link?.clients.values() || []].some((c) => c.did === micId)) return toast('选的录音设备不在线');
    this.calibPrep();
    this.calibrating = true; for (const b of ['#calibBtn', '#musicCalBtn', '#checkBtn']) $(b) && ($(b).disabled = true);
    const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
    const before = Object.fromEntries(devs.map((d) => [d.id, d.latencyMs]));
    const hist = []; // 每一轮：各设备之间最大差距
    let rows = null, firstRows = null, done = false, stuck = false, warnLost = [];
    try {
      out('🎙 打开麦克风中…（如果弹出权限询问，请点“允许”）');
      // 整个校准期间由校准串流接管（中间是静音），先送 1.5 秒让所有设备从音乐切换过来、稳定下来
      this.calStreamStart(devs);
      await sleep(1500);
      for (let it = 1; it <= 6 && !done; it++) {
        rows = await this.measureStream(devs, micId, 4, out, it === 1 ? '测量' : `调整后再量一次（第 ${it} 轮）`);
        if (!firstRows) firstRows = rows;
        let good = rows.filter((r) => r.ok);
        warnLost = rows.filter((r) => !r.ok);
        // 有设备只量到粗略值：这一轮不算数（不能当作验证），但先用粗略值把它拉近，下一轮再精确量
        const rough = rows.filter((r) => !r.ok && r.rough !== null);
        if (rough.length && good.length + rough.length >= 2) {
          const all = [...good.map((r) => [r, r.val]), ...rough.map((r) => [r, r.rough])];
          const E0 = Math.max(...all.map((x) => x[1]));
          hist.push(E0 - Math.min(...all.map((x) => x[1])));
          const nl = new Map(all.map(([r, v]) => [r.d, r.d.latencyMs + (E0 - v)])), mn = Math.min(...nl.values());
          for (const [d, v] of nl) d.latencyMs = r2(Math.max(0, Math.min(1000, v - mn)));
          this.changed(); this.lastWire = ''; this.publish();
          out('⏳ 先粗调，等各设备套用新设置…'); await sleep(3000);
          continue;
        }
        if (good.length < 2) break;
        const E = Math.max(...good.map((r) => r.val)), spread = E - Math.min(...good.map((r) => r.val));
        hist.push(spread);
        // 记录真实延迟（给画面同步用）：听到时刻 - 串流时间 - 缓冲 - 排定的延迟
        const pm = this.plans();
        for (const r of good) r.d.realLat = r1(r.val - H.liveDelay - this.totalD(r.d, pm));
        if (spread <= 0.5) { done = true; break; }
        // 连续三轮都没有变好（而且还差 2ms 以上）：设备可能没有照新的微调出声，停下来回报
        if (hist.length >= 4 && hist.slice(-3).every((v, k, a) => k === 0 || v > a[k - 1] * 0.8) && hist[hist.length - 1] > 2) { stuck = true; break; }
        // 以最晚的那台为准，其他设备各自延后“比它早多少”
        const nl = new Map(good.map((r) => [r.d, r.d.latencyMs + (E - r.val)]));
        const mn = Math.min(...nl.values());
        for (const [d, v] of nl) d.latencyMs = r2(Math.max(0, Math.min(1000, v - mn)));
        this.changed(); this.lastWire = ''; this.publish();
        out('⏳ 已调整，等各设备套用新设置…');
        await sleep(3000);
      }
      const name = (d) => esc(d.name);
      const first = firstRows || [], firstGood = first.filter((r) => r.ok);
      const fE = firstGood.length ? Math.max(...firstGood.map((r) => r.val)) : 0;
      const last = new Map((rows || []).map((r) => [r.d, r]));
      const lE = rows ? Math.max(...rows.filter((r) => r.ok).map((r) => r.val), -Infinity) : 0;
      const why = (r) => r.heard === 0
        ? '没录到它的声音：确认它有在播放（没静音、音量够大），离麦克风近一点'
        : `只听清楚 ${r.heard}/${r.of} 次（清晰度 ${r.clarity.toFixed(1)}）：周围太吵或回音太大，靠近一点再试`;
      const table = `<table class="small" style="width:100%;margin-top:6px"><tr class="muted"><td>设备</td><td>校准前</td><td>校准后</td><td>微调</td></tr>${devs.map((d) => {
        const f = first.find((r) => r.d === d), l = last.get(d);
        const pre = f?.ok ? `${(fE - f.val) < 0.05 ? '最晚的那台' : `早 ${(fE - f.val).toFixed(1)} ms`}` : '—';
        const post = l?.ok ? `${Math.abs(lE - l.val) <= 0.5 ? '✅' : '🔧'} ${(lE - l.val).toFixed(2)} ms` : `<span style="color:var(--bad)">没听到</span><div class="muted">${why(l || f)}</div>`;
        return `<tr><td>${name(d)}</td><td>${pre}</td><td>${post}${l?.spread != null ? `<div class="muted">4 次测量相差 ${l.spread.toFixed(2)} ms</div>` : ''}</td><td class="muted">${before[d.id]} → ${d.latencyMs} ms</td></tr>`;
      }).join('')}</table>`;
      const trend = hist.length ? `<div class="muted">每一轮各设备之间最大差距：${hist.map((v) => v.toFixed(2) + ' ms').join(' → ')}</div>` : '';
      // ===== 最后用音乐确认：音乐恢复后，各设备轮流单独放音乐，直接量“音乐”在你耳朵的位置谁早谁晚 =====
      // （校准音和音乐理论上走同一条路；如果某台设备的音乐跟校准音不一样，或有不经过 SoundMesh 的另一份声音，这一步会抓到）
      let music = null;
      if (done && this.live.running) {
        this.calStreamStop(); // 校准串流交还给音乐
        await sleep(3000); // 让音乐接回来、设备稳定
        const ring = (this.srcRing || []).slice(-100);
        let e2 = 0, n2 = 0; for (const c of ring) for (let i = 0; i < c.x.length; i += 4) { e2 += c.x[i] * c.x[i]; n2++; }
        if (n2 && Math.sqrt(e2 / n2) > 0.003) {
          const md = devs.filter((d) => rows.find((r) => r.d === d)?.ok);
          music = { rounds: [] };
          const pass = async (lab) => {
            const mr = await this.musicPass(md, micId, 400, out, lab);
            const okm = mr.filter((r) => r.ok);
            if (okm.length >= 2) { const med = median(okm.map((r) => r.val)); for (const r of okm) r.mdiff = r.val - med; }
            music.early = this.earlyCopy; music.rows = mr;
            return okm.length >= 2 ? new Map(okm.map((r) => [r.d, r])) : null;
          };
          const A = await pass('用音乐确认');
          if (!A) music.fail = true;
          else {
            const worstA = Math.max(...[...A.values()].map((r) => Math.abs(r.mdiff)));
            music.rounds.push(worstA);
            if (worstA > 1) {
              // 音乐和校准音的结果不一样：再量一次音乐，两次一致（1ms 内）才相信，按音乐修正（音乐才是你实际听的）
              const B = await pass('音乐结果和校准音不同，再量一次确认');
              const both = B ? [...A.keys()].filter((d) => B.has(d) && Math.abs(A.get(d).mdiff - B.get(d).mdiff) <= 1) : [];
              if (both.length >= 2 && both.length === A.size) {
                const fix = new Map(both.map((d) => [d, (A.get(d).mdiff + B.get(d).mdiff) / 2]));
                const mx = Math.max(...fix.values());
                const nl = new Map([...fix].map(([d, v]) => [d, d.latencyMs + (mx - v)])), mn = Math.min(...nl.values());
                for (const [d, v] of nl) d.latencyMs = r2(Math.max(0, Math.min(1000, v - mn)));
                music.fixed = true;
                this.changed(); this.lastWire = ''; this.publish();
                await sleep(3000);
                const C = await pass('修正后用音乐验证');
                if (C) music.rounds.push(Math.max(...[...C.values()].map((r) => Math.abs(r.mdiff))));
              } else music.unstable = true;
            }
          }
        }
      }
      const musicHtml = !music ? (this.live.running ? '<div class="muted">（现在没有在放歌，没有用音乐再确认；放着歌时再按一次会多这一步）</div>' : '')
        : music.fail ? '<div class="muted">用音乐确认时没比对成功（歌太安静或有其他声音），以校准音的结果为准。</div>'
        : music.unstable ? `<div class="muted">🎵 用音乐量到的结果前后不一致（这首歌可能节奏太规律），没有采用，以校准音的结果为准：${music.rows.map((r) => `${esc(r.d.name)} ${r.ok ? `${r.mdiff >= 0 ? '晚' : '早'} ${Math.abs(r.mdiff).toFixed(1)} ms` : '没比对到'}`).join(' · ')}</div>`
        : `<div style="margin-top:6px">🎵 用音乐确认：${music.rows.map((r) => `${esc(r.d.name)} ${r.ok ? `${r.mdiff >= 0 ? '晚' : '早'} ${Math.abs(r.mdiff).toFixed(1)} ms` : '没比对到'}`).join(' · ')}
            ${music.rounds.length > 1 ? `<div class="muted">音乐和校准音有差别，已经按音乐修正：${music.rounds.map((v) => v.toFixed(1) + ' ms').join(' → ')}</div>` : music.rounds[0] <= 1 ? '<div class="muted">音乐和校准音的结果一致 ✅</div>' : ''}</div>`;
      const earlyHtml = music && music.early !== null && music.early !== undefined
        ? `<div style="color:var(--bad);margin-top:6px">⚠️ <b>还听到一份不经过 SoundMesh 的同一首歌</b>（比所有设备早很多）。这通常是<b>电脑自己还在直接放 YouTube</b>：它不受 SoundMesh 控制，会听起来像某一台特别早。解决：改用 SoundMesh 扩展来分享（会自动把原分页静音），或在 Windows 音量混合器里把这个浏览器分页的声音关掉（只关原分页，不要关 SoundMesh 自己）。</div>` : '';
      if (done) {
        out(`✅ 校准完成：实际量到各设备之间最多差 <b>${hist[hist.length - 1].toFixed(2)} ms</b>${hist.length > 1 ? '（调整后重新量过确认）' : '（本来就已经对齐）'}${warnLost.length ? `，但 ${warnLost.map((r) => name(r.d)).join('、')} 没听到，没有调整它` : ''}
          ${table}${trend}${musicHtml}${earlyHtml}<div class="muted" style="margin-top:4px">测的是在麦克风位置听到的时间，请在麦克风的位置听（声音每 1 ms 走 34 cm）。</div>`);
        $('#calibUndo').hidden = false; this.calUndo = before;
      } else if (stuck) {
        out(`⚠️ 调整了但没有变化，可能有设备没有套用新设置。${table}${trend}<div class="muted">请截图给我。</div>`);
        this.calUndo = before; $('#calibUndo').hidden = false;
      } else if (hist.length) {
        out(`⚠️ 调了 ${hist.length} 轮还没收敛到 0.5 ms 内（目前最多差 ${hist[hist.length - 1].toFixed(2)} ms）。${table}${trend}<div class="muted">可以再按一次继续；如果每次都差很多，请截图给我。</div>`);
        this.calUndo = before; $('#calibUndo').hidden = false;
      } else {
        out(`⚠️ 需要至少两台设备被听清楚才能对齐。${table}`);
      }
      this.changed();
    } catch (e) {
      out('❌ ' + esc(e.message || String(e)));
    } finally {
      this.calStreamStop();
      this.calibrating = false; for (const b of ['#calibBtn', '#musicCalBtn', '#checkBtn']) $(b) && ($(b).disabled = false);
    }
  },

  // 一个按钮：有音乐在播就用音乐校准（最准，测的就是你听到的），没有就用“啾”声
  // 🔔 对齐测试：所有设备在同一瞬间各响一声“叮”（每台音高不同），每秒一次、共 15 下。
  // 对齐：每下听起来是一个清脆的和弦；没对齐：会听到“嗒-叮”分成几下，音高告诉你是哪一台。走的和音乐完全同一条路。
  async alignTest() {
    if (this.calibrating) return;
    if (H.currentGroupId !== 'live') return toast('先选“实时音源”并开始共享电脑声音，再做对齐测试');
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (devs.length < 2) return toast('至少要两台设备在线');
    const FREQ = [523.25, 783.99, 1174.66, 1760, 2637.02, 3951.07]; // C5 G5 D6 A6 E7 B7：低到高，彼此是五度，叠在一起好听、也好分辨
    const click = (i) => {
      const f = FREQ[i % FREQ.length], n = Math.round(48000 * 0.06), x = new Float32Array(n);
      for (let k = 0; k < n; k++) { const t = k / 48000; x[k] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 60) * Math.min(1, k / 24) * 0.6; }
      return x;
    };
    const out = (h) => ($('#calibOut').innerHTML = h);
    this.calibrating = true; for (const b of ['#calibBtn', '#alignTestBtn', '#checkBtn']) $(b) && ($(b).disabled = true);
    try {
      this.calStreamStart(devs, [], click);
      await sleep(1500);
      const T0 = hostNow() + 600, sched = [];
      for (let k = 0; k < 15; k++) for (const d of devs) sched.push({ did: d.id, ts: T0 + k * 1000 });
      this.calGen.setSched(sched);
      const legend = devs.map((d, i) => `<b>${esc(d.name)}</b> ${['最低音', '低音', '中音', '中高音', '高音', '最高音'][i] || ''}`).join('、');
      out(`🔔 对齐测试中（约 16 秒）：每秒一下“叮”。<br>每下听起来是<b>一个清脆的和弦</b>＝对齐了；听到<b>“嗒-叮”分成两三下</b>＝没对齐，先响的那个音高就是比较早的设备。<br>音高：${legend}<div class="muted">也可以用手机在你坐的位置录下来传给我，我能算出每台差几毫秒。</div>`);
      await sleep(T0 + 15000 + H.liveDelay + 1500 - hostNow());
      out(`🔔 对齐测试结束。音高对照：${legend}<div class="muted">录音的话请传给我。</div>`);
    } finally {
      this.calStreamStop();
      this.calibrating = false; for (const b of ['#calibBtn', '#alignTestBtn', '#checkBtn']) $(b) && ($(b).disabled = false);
    }
  },

  async smartCalibrate() {
    return this.streamCalibrate();
  },
  async smartCalibrateOld() {
    if (this.group()?.kind === 'live' && this.live.running) {
      // 最近 3 秒真的有声音才用音乐校准（暂停中/安静段落用音乐一定比对不上）
      const ring = (this.srcRing || []).slice(-150);
      let e = 0, n = 0; for (const c of ring) for (let i = 0; i < c.x.length; i += 4) { e += c.x[i] * c.x[i]; n++; }
      if (n && Math.sqrt(e / n) > 0.003) return this.musicCalibrate();
      toast('现在没有在放歌（或正在安静的段落），这次用“啾”声校准');
    }
    return this.calibrate();
  },
  // 校准时测的是真实距离：关掉“按画布距离补偿延迟”，以后在画布上拖动设备也不会打乱同步
  calibPrep() {
    if (H.options?.distanceDelay) { H.options.distanceDelay = false; toast('已关闭“按距离补偿延迟”：校准按实际测量对齐，之后在画布上拖动设备不会打乱同步'); this.changed(); }
  },

  async calibrate({ rounds = 4, verify = true } = {}) {
    if (this.calibrating) return;
    this.calibPrep();
    const out = (h) => ($('#calibOut').innerHTML = h);
    const micId = $('#calibMic').value;
    const devs = Object.values(H.devices).filter((d) => d.online && (d.id !== 'self' || this.selfEngine));
    if (!devs.length) return toast('还没有在线的播放设备');
    if (micId !== 'self' && ![...this.link?.clients.values() || []].some((c) => c.did === micId)) return toast('选的录音设备不在线');
    this.calibrating = true; $('#calibBtn').disabled = true;
    const r1 = (v) => Math.round(v * 10) / 10;
    try {
      out('🎙 打开麦克风中…（如果弹出权限询问，请点“允许”）');
      this.chirpAcks = {};
      const hiddenDevs = devs.filter((d) => d.id !== 'self' && d.stats?.hidden);
      if (hiddenDevs.length) toast(`⚠️ ${hiddenDevs.map((d) => d.name).join('、')} 的 SoundMesh 在后台，可能播不出测试音：请把它切回前台、亮着屏幕`);
      // 第 1 步：每台设备“啾”5 轮。不套用以前的延迟微调，直接量出每台设备真实的延迟
      const rows = await this.measureChirps(devs, micId, rounds, out, verify ? '第 1 步：测量各设备真实的延迟' : '粗测各设备的延迟', true);
      const plans0 = this.plans();
      for (const r of rows) r.e = r.val === null ? null : r.val - (plans0[r.d.id]?.delayMs || 0); // 扣掉按位置故意加的延迟
      const valid = rows.filter((r) => r.e !== null);
      if (!valid.length) throw new Error('没有录到清楚的“啾”声：把录音设备放近一点、把音量调大、保持安静再试');
      // 以最慢的那台为准：其他设备等它（延迟微调都是 0 或正数）。这样没有设备需要“提前播”，缓冲可以压到最低
      const slowest = Math.max(...valid.map((r) => r.e));
      this.calUndo = Object.fromEntries(devs.map((d) => [d.id, d.latencyMs]));
      for (const r of valid) { r.first = r.e; r.d.realLat = r1(r.e); r.d.latencyMs = Math.max(0, Math.min(1000, r1(slowest - r.e))); }
      const ref = 0;
      this.changed(); this.lastWire = ''; this.publish();
      await sleep(1500); // 等新设置传到每台设备
      // 第 2 步：再测 2 轮验证；还有超过 0.3ms 的偏差就再修正一次（粗测时跳过）
      const check = verify ? await this.measureChirps(valid.map((r) => r.d), micId, 2, out, '第 2 步：验证校准结果') : valid.map((r) => ({ d: r.d, val: null }));
      const cv = check.filter((r) => r.val !== null), ref2 = cv.length ? median(cv.map((r) => r.val)) : 0;
      // 顺便算出“声音真正到你耳朵比预定晚多少”（手机喇叭/蓝牙的真实延迟，浏览器报的数字常常不准），
      // 看视频时画面就按这个自动延后，不用手动微调
      const plansNow = this.plans(), Dof = (d) => (plansNow[d.id]?.delayMs || 0) + (d.latencyMs || 0);
      const eList = cv.length ? cv.map((c) => c.val - Dof(c.d)) : [];
      if (eList.length) { H.avBase = Math.round(median(eList) * 10) / 10; H.avCalAt = Date.now(); }
      for (const c of cv) c.d.realLat = r1(c.val - Dof(c.d)); // 每台设备实测的真实延迟（看视频时算画面要延后多少）
      for (const c of cv) {
        const row = rows.find((r) => r.d === c.d);
        row.resid = c.val - ref2;
        if (Math.abs(row.resid) > 0.3) { c.d.latencyMs = Math.max(-1000, Math.min(1000, r1(c.d.latencyMs - row.resid))); row.fixed = true; }
      }
      // 再修正后如果有设备变成负数（要提前播），所有设备一起往后挪，保持都 ≥ 0（相对关系不变）
      const minLat = Math.min(...valid.map((r) => r.d.latencyMs));
      if (minLat < 0) for (const r of valid) r.d.latencyMs = r1(r.d.latencyMs - minLat);
      const verified = rows.filter((r) => r.resid !== undefined && !r.fixed), nFixed = rows.filter((r) => r.fixed).length;
      const worst = Math.max(0, ...verified.map((r) => Math.abs(r.resid)));
      out(`✅ 校准完成：${verified.length ? `验证结果各设备之间误差 <b>${worst < 0.3 ? '0.3 ms 以内' : worst.toFixed(1) + ' ms'}</b>（声音 1ms 只走 34cm，已经听不出先后）` : ''}${nFixed ? `；${nFixed} 台验证时还差一点，已自动再修正（想确认可以再按一次校准）` : ''}
        <table class="small" style="width:100%;margin-top:6px">${rows.map((r) => `<tr><td>${esc(r.d.name)}</td>
          <td>${r.val === null ? `<span style="color:var(--bad)">没听清（${r.n}/${r.of}）</span><div class="muted">${this.chirpWhy(r.d)}</div>` : `比最快的那台慢 ${(r.first - Math.min(...valid.map((v) => v.first))).toFixed(1)} ms`}</td>
          <td>${r.resid === undefined ? (r.val === null ? '未调整' : '验证没听清') : `校准后 ${Math.abs(r.resid) < 0.3 ? '✅' : '🔧'} ${r.resid >= 0 ? '+' : ''}${r.resid.toFixed(1)} ms${r.fixed ? '（已再修正）' : ''}`}</td>
          <td class="muted">微调 → ${r.d.latencyMs} ms</td></tr>`).join('')}</table>`);
      if (eList.length) $('#calibOut').insertAdjacentHTML('beforeend', `<div class="muted" style="margin-top:4px">🎬 看视频时画面会自动延后到和声音对齐（现在约 ${Math.round(this.mirrorDelay())} ms，已算进各设备喇叭的真实延迟）</div>`);
      $('#calibUndo').hidden = false;
      this.changed();
    } catch (e) {
      out('❌ ' + esc(e.message || String(e)));
    } finally {
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
      this.drag = { obj, dx: obj.x * 100 - p.x, dy: obj.y * 100 - p.y, id: g.dataset.drag === 'dev' ? g.dataset.id : null, x0: e.clientX, y0: e.clientY, moved: false };
      svg.setPointerCapture(e.pointerId);
      // 选中设备，但拖动时不滚动页面（以前会把页面/右栏滚到设备卡片，手机上整页跳走）
      if (this.drag.id) { this.selected = this.drag.id; this.renderSoon(); }
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      e.preventDefault();
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 3) d.moved = true;
      const p = pt(e);
      d.obj.x = Math.min(H.size.w, Math.max(0, (p.x + d.dx) / 100));
      d.obj.y = Math.min(H.size.h, Math.max(0, (p.y + d.dy) / 100));
      // 拖动中只重画画布（每帧一次），设备那边每 80ms 更新一次；放手后再刷新整页
      if (!this.dragFrame) this.dragFrame = requestAnimationFrame(() => { this.dragFrame = null; this.renderCanvas(this.plans()); });
      if (!this.pubTimer) this.pubTimer = setTimeout(() => { this.pubTimer = null; this.publish(); }, 80);
    }, { passive: false });
    const end = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.moved) this.changed();
      // 只是点一下（没拖）：电脑上把右栏滚到这台设备的设置（不动整页）
      else if (d.id) {
        this.select(d.id, matchMedia('(min-width: 901px)').matches);
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  },
  select(id, scroll = true) {
    this.selected = id;
    this.render();
    if (scroll) this.cards.get(id)?.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    $('#liveBtn').textContent = on ? '■ 停止共享' : window.SoundMeshApp ? '🎙 开始抓手机声音' : '🎙 开始共享电脑声音';
    $('#liveBtn').className = on ? 'danger' : 'primary';
    $('#liveLevel').style.width = `${Math.min(100, this.live.stats.level * 100)}%`;
    if (document.activeElement !== $('#liveDelay')) $('#liveDelay').value = H.liveDelay;
    $('#liveDelayVal').textContent = `${H.liveDelay} ms`;
    $('#quality').value = H.quality || (H.opus ? 'high' : 'lossless');
    $('#qualityHint').textContent = { lossless: '原始 CD 音质，每台约 1.5 Mbps，手机热点/家里 Wi-Fi 都够；网络不好、断断续续时再改成下面两种', high: 'Opus 320kbps，几乎听不出和无损的差别，流量只要无损的 1/5', standard: 'Opus 160kbps，网络很差的时候用' }[$('#quality').value] || '';
    $('#autoDelay').checked = H.autoDelay;
    $('#pcPlay').checked = H.pcPlay !== false;
    $('#liveStems').checked = !!H.liveStems;
    $('#videoMode').checked = !!H.videoMode;
    if (document.activeElement !== $('#mirrorOffset')) $('#mirrorOffset').value = H.mirrorOffset || 0;
    $('#mirrorOffsetVal').textContent = `${(H.mirrorOffset || 0) > 0 ? '+' : ''}${H.mirrorOffset || 0} ms`;
    $('#mirrorInfo').textContent = `画面延后 ${Math.round(this.mirrorDelay())} ms，和手机的声音对齐`;
    const clients = [...this.link?.clients.values() || []].filter((c) => c.did);
    const opusN = clients.filter((c) => this.opusFor(c)).length;
    const dropped = clients.reduce((a, c) => a + (c.dropped || 0), 0);
    const lagTxt = (this.live.running && this.lagShown !== undefined ? ` · ${this.live.surface === 'android' ? '手机' : '电脑'}处理延迟 ${Math.round(this.lagShown)} ms` : '') + (this.delayFloor ? ` · 现在最低可到 ${this.delayFloor} ms${this.delayFloorBy && this.totalD(this.delayFloorBy) < -30 ? `（${this.delayFloorBy.name} 的延迟微调是 ${Math.round(this.totalD(this.delayFloorBy))} ms，要“提前播”这么多，所以需要更多缓冲）` : ''}` : '') + (document.documentElement.dataset.smExt && this.live.running ? ` · 🎞️ 扩展已连接：YouTube 画面延后 ${Math.round(this.mirrorDelay())} ms` : '');
    const surf = { browser: '标签页 ✅', window: '窗口 ⚠️', monitor: '整个屏幕 ⚠️', android: '手机 App 声音 ✅' }[this.live.surface] || '未知';
    $('#liveStatus').textContent = on
      ? `${H.liveStems ? (this.sep ? '🎚 拆声部中 · ' : '🎚 拆声部（等待分工模式） · ') : ''}共享类型：${surf}${lagTxt}${this.live.surface === 'android' ? '（这台手机会照常播放原声，比其他设备早一点）' : this.live.surface !== 'browser' ? '（电脑原声不会静音，手机会比电脑晚）' : ''} · 正在采集 · 已发送 ${this.live.stats.chunks} 段 · ${opusN ? `${opusN} 台用 Opus ${H.quality === 'standard' ? '160' : '320'}kbps、` : ''}${clients.length - opusN} 台用无损 PCM${dropped ? ` · 网络丢弃 ${dropped} 段` : ''}`
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
    $('#bandBox').style.display = H.mode === 'band' ? '' : 'none';
    if (H.mode === 'band') {
      $('#bandGlue').value = Math.round((H.bandGlue ?? 0.25) * 100); $('#bandGlueVal').textContent = Math.round((H.bandGlue ?? 0.25) * 100) + '%';
      const pm = this.plans(), g = this.group();
      $('#bandRoles').innerHTML = g?.kind !== 'live' ? '<div style="color:var(--warn,#f59f00)">乐团模式目前用于“电脑实时音源”。播放文件时会自动按协同播放处理。</div>'
        : `<table class="small" style="width:100%">${Object.values(H.devices).filter((d) => d.online && pm[d.id]?.band).map((d) => { const c = this.capOf(d); return `<tr><td><span style="color:${d.color}">●</span> ${esc(d.name)}<div class="muted">${c.measured ? '实测' : '估计'}：低音到 ${c.low}Hz</div></td><td>${esc(this.bandLabel(pm[d.id].band))}</td></tr>`; }).join('')}</table>`;
    }
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
    $('#micDevRow').style.display = $('#micDevHint').style.display = $('#calibMic').value === 'self' ? '' : 'none';
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
      const a = plan.band ? ` · 🎼 <b>${esc(this.bandLabel(plan.band))}</b>` : H.mode === 'split' ? ` · 负责 <b>${plan.assign.map((k) => esc(assignLabel(H, k))).join(' + ') || '无'}</b>` : '';
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
  // 时钟同步：用往返最快的那些 ping 估算“控制端时钟 - 本机时钟”的差值。
  // 另外估算两边时钟走快/走慢的速度（漂移），提前补偿——几分钟一次的小误差也不会累积。
  constructor() { this.reset(); }
  reset() { this.samples = []; this.offset = null; this.rtt = null; this.jitter = null; this.model = null; this.skew = 0; }
  get synced() { return this.offset !== null && this.samples.length >= 3; }
  offsetAt(t) { return this.model ? this.model.a + this.model.b * (t - this.model.t) : (this.offset ?? 0); }
  now() { const t = performance.now(); return t + this.offsetAt(t); }
  add(c, s, t1 = performance.now()) {
    const rtt = t1 - c;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, offset: s + rtt / 2 - t1, at: t1 });
    this.samples = this.samples.filter((x) => t1 - x.at < 300000).slice(-500);
    // 每 4 秒一组，只取这组里往返最快的一次（最快的那次网络排队最少，最准）
    const buckets = new Map();
    for (const x of this.samples) { const k = Math.floor(x.at / 4000), b = buckets.get(k); if (!b || x.rtt < b.rtt) buckets.set(k, x); }
    let pts = [...buckets.values()].sort((a, b) => a.at - b.at);
    const minR = Math.min(...pts.map((p) => p.rtt));
    pts = pts.filter((p) => p.rtt <= minR * 1.6 + 4); // 网络特别堵的那几组不用
    this.rtt = minR;
    const recent = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(Math.min(this.samples.length, 15) / 3)));
    const simple = recent.reduce((a, b) => a + b.offset, 0) / recent.length;
    let model;
    if (pts.length >= 6 && pts[pts.length - 1].at - pts[0].at > 40000) {
      // 直线拟合：offset = a + b × 时间（b 就是两边时钟的快慢差）
      const tr = pts[pts.length - 1].at, n = pts.length;
      const mx = pts.reduce((a, p) => a + (p.at - tr), 0) / n, my = pts.reduce((a, p) => a + p.offset, 0) / n;
      let sxx = 0, sxy = 0;
      for (const p of pts) { sxx += (p.at - tr - mx) ** 2; sxy += (p.at - tr - mx) * (p.offset - my); }
      const b = Math.max(-3e-4, Math.min(3e-4, sxx ? sxy / sxx : 0));
      model = { a: my - b * mx, b, t: tr };
      const res = pts.map((p) => p.offset - (model.a + b * (p.at - tr)));
      this.jitter = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / n) * 2;
    } else {
      model = { a: simple, b: 0, t: t1 };
      this.jitter = recent.length > 1 ? Math.max(...recent.map((x) => x.offset)) - Math.min(...recent.map((x) => x.offset)) : null;
    }
    // 新估算和现在用的差太多（比如重新连线）就直接换；差一点点就平滑过渡，避免声音跳一下
    const cur = this.model ? this.offsetAt(t1) : null, next = model.a + model.b * (t1 - model.t);
    if (cur !== null && Math.abs(next - cur) <= 40) model.a -= (next - cur) * 0.5;
    this.model = model; this.skew = model.b; this.offset = this.offsetAt(t1);
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
    this.lastRx = performance.now();
    this.link.addEventListener('msg', (e) => { this.lastRx = performance.now(); this.onMsg(e.detail); });
    this.link.addEventListener('bin', (e) => { this.lastRx = performance.now(); this.onBin(e.detail); });
    // 心跳：控制端每几秒一定会回应对时；超过 7 秒什么都没收到 = 连接假死，马上重连
    setInterval(() => {
      if (this.link.connected && performance.now() - this.lastRx > 7000) { this.lastRx = performance.now(); this.link.kick?.(); }
    }, 1000);
    setInterval(() => this.burst(4), 4000); // 更密的对时：每 4 秒 4 个 ping（流量很小）
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
    } else if (m.t === 'hush') {
      this.engine.hush(!!m.on, m.at);
    } else if (m.t === 'lyrics') {
      this.lyrics = m.ly;
    } else if (m.t === 'sweep') {
      if (m.until) this.engine.duck(m.until);
      if (m.at) this.engine.playSweepAt(m.at);
    } else if (m.t === 'chirp' && Array.isArray(m.at)) {
      if (m.until) this.engine.duck(m.until);
      const played = m.at.filter((t) => this.engine.playChirpAt(t, !!m.raw)).length;
      // 告诉控制端：测试音有没有真的播出来（没播出来通常是页面在后台/声音被系统暂停）
      this.link.send({ t: 'chirpAck', played, total: m.at.length, hidden: document.visibilityState !== 'visible', state: this.engine.ctx.state, unlocked: this.engine.unlocked });
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
        if (m.kind === 'raw') {
          // 把录音（24kHz、16 位）分段传回控制端，由控制端和原声比对
          const x = toRate(data.rec, data.sr, 24000), pcm = new Int16Array(x.length);
          for (let i = 0; i < x.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
          // 每段 ≤ 11000 字节（base64 后约 14.7KB）：连线函数库的文字消息上限约 16KB，超过会被默默丢掉
          const bytes = new Uint8Array(pcm.buffer), PART = 11000, n = Math.ceil(bytes.length / PART);
          for (let i = 0; i < n; i++) {
            let s = ''; const sub = bytes.subarray(i * PART, (i + 1) * PART);
            for (let j = 0; j < sub.length; j += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(j, j + 0x8000));
            this.link.send({ t: 'recPart', i, b64: btoa(s) });
          }
          this.link.send({ t: 'measureResult', raw: { n, startHost: data.startHost, inLat: data.inLat || 0, rate: 24000 } });
          return;
        }
        const results = m.kind === 'response'
          ? analyzeResponse(data, m.windows, m.noise)
          : m.kind === 'spectrum'
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
        live: isLive ? { got: e.liveStats.got, late: e.liveStats.late, res: e.liveStats.resyncs, concealed: e.liveStats.concealed || 0 } : null, drifts: e.resyncs,
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
      if (isLive) $('#pbLine').textContent = `🔴 ${window.SoundMeshApp || cur.app ? '手机' : '电脑'}实时音源 · ${pb.status === 'playing' ? `正在接收（缓冲 ${cur.ld} ms）` : '控制端还没开始共享'}`;
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
      ['时钟同步', this.clock.synced ? `往返 ${n(this.clock.rtt, 1)} ms · 抖动 ${n(this.clock.jitter, 1)} ms · 时钟快慢差 ${n(this.clock.skew * 1e6, 0)} ppm` : this.link?.connected ? '同步中…' : '等待连接'],
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
