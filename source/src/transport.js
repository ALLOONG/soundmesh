// 设备之间的连接：WebRTC 直连（PeerJS）。
// 控制端用固定 ID（由房间号生成），播放节点连过去；建立两条通道：
//   ctl：JSON 控制消息（状态、时钟同步、统计）
//   bin：二进制（音频文件、实时音频分段）

const ID_PREFIX = 'soundmesh-v1-';

function peerOptions() {
  // ?peer=host:port 可以换成自己架的 PeerJS 服务器；默认用 PeerJS 免费公共服务器
  const q = new URLSearchParams(location.search).get('peer');
  const base = { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };
  if (!q) return base;
  const [host, port] = q.split(':');
  return { ...base, host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:' && host !== 'localhost' };
}

// 二进制帧：[u16 头长度][头 JSON][数据]
export function packBin(hdr, payload) {
  const h = new TextEncoder().encode(JSON.stringify(hdr));
  const p = payload ? new Uint8Array(payload.buffer ? payload.buffer : payload, payload.byteOffset || 0, payload.byteLength) : new Uint8Array(0);
  const out = new Uint8Array(2 + h.length + p.length);
  new DataView(out.buffer).setUint16(0, h.length);
  out.set(h, 2); out.set(p, 2 + h.length);
  return out.buffer;
}
export function unpackBin(buf) {
  const u = new Uint8Array(buf);
  const n = new DataView(u.buffer, u.byteOffset).getUint16(0);
  const hdr = JSON.parse(new TextDecoder().decode(u.subarray(2, 2 + n)));
  return { hdr, payload: u.subarray(2 + n) };
}

// ---------------- 控制端 ----------------
export class HostLink extends EventTarget {
  constructor(code) {
    super();
    this.code = code;
    this.clients = new Map(); // peerId -> { ctl, bin, did }
    this.open = false;
    this.start();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  start() {
    const peer = (this.peer = new window.Peer(ID_PREFIX + this.code.toLowerCase(), peerOptions()));
    peer.on('open', () => { this.open = true; this.emit('status', 'open'); });
    peer.on('disconnected', () => { // 和信令服务器断开：已建立的直连不受影响，重连信令即可
      this.emit('status', 'signal-lost');
      setTimeout(() => { if (!peer.destroyed) try { peer.reconnect(); } catch {} }, 1500);
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') this.emit('status', 'taken');
      else if (e.type === 'peer-unavailable') { /* 忽略 */ } else this.emit('status', 'error:' + (e.type || e.message));
    });
    peer.on('connection', (conn) => {
      const c = this.clients.get(conn.peer) || { did: null, ctl: null, bin: null, link: this, via: 'peerjs' };
      this.clients.set(conn.peer, c);
      if (conn.label === 'bin') c.bin = conn; else c.ctl = conn;
      conn.on('data', (data) => {
        if (conn.label === 'bin') return;
        if (data && data.t === 'hello') c.did = String(data.did || '').slice(0, 20);
        this.emit('msg', { from: conn.peer, client: c, msg: data });
      });
      const gone = () => {
        if (conn.label === 'bin') c.bin = null; else c.ctl = null;
        if (!c.ctl && !c.bin) this.clients.delete(conn.peer);
        this.emit('peers');
      };
      conn.on('close', gone);
      conn.on('error', gone);
      conn.on('open', () => this.emit('peers'));
    });
  }
  restartWithCode(code) { try { this.peer.destroy(); } catch {} this.code = code; this.open = false; this.start(); }
  send(c, msg) { if (c.ctl?.open) try { c.ctl.send(msg); } catch {} }
  broadcast(msg) { for (const c of this.clients.values()) if (c.did) this.send(c, msg); }
  sendBin(c, buf) {
    if (!c.bin?.open) return false;
    try { c.bin.send(buf); return true; } catch { return false; }
  }
  buffered(c) { return c.bin?.dataChannel?.bufferedAmount || 0; }
}

// ---------------- 播放节点 ----------------
export class NodeLink extends EventTarget {
  constructor(code, helloFn) {
    super();
    this.code = code;
    this.helloFn = helloFn;
    this.ctl = null; this.bin = null;
    this.connected = false;
    this.via = 'peerjs';
    this.start();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  close() { this.closed = true; clearTimeout(this.retryTimer); try { this.peer.destroy(); } catch {} }
  start() {
    if (this.closed) return;
    const peer = (this.peer = new window.Peer(peerOptions()));
    peer.on('open', () => this.connect());
    peer.on('disconnected', () => setTimeout(() => { if (!peer.destroyed) try { peer.reconnect(); } catch {} }, 1500));
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') { this.emit('status', 'no-host'); this.retry(3000); }
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { this.emit('status', 'signal-error'); this.retry(3000); }
      else this.emit('status', 'error:' + e.type);
    });
  }
  retry(ms) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.connected || this.closed) return;
      if (this.peer.destroyed || this.peer.disconnected) { try { this.peer.destroy(); } catch {} this.start(); }
      else this.connect();
    }, ms);
  }
  connect() {
    try { this.ctl?.close(); this.bin?.close(); } catch {}
    const hostId = ID_PREFIX + this.code.toLowerCase();
    const ctl = (this.ctl = this.peer.connect(hostId, { label: 'ctl', serialization: 'json', reliable: true }));
    const bin = (this.bin = this.peer.connect(hostId, { label: 'bin', serialization: 'raw', reliable: true }));
    this.emit('status', 'connecting');
    const check = () => {
      if (ctl.open && bin.open && !this.connected) {
        this.connected = true;
        this.send(this.helloFn());
        this.emit('status', 'open');
      }
    };
    ctl.on('open', check); bin.on('open', check);
    ctl.on('data', (m) => this.emit('msg', m));
    bin.on('data', (d) => this.emit('bin', unpackBin(d)));
    const lost = () => {
      if (this.ctl !== ctl) return;
      this.connected = false;
      this.emit('status', 'lost');
      this.retry(2000);
    };
    ctl.on('close', lost); bin.on('close', lost); ctl.on('error', lost); bin.on('error', lost);
    // 10 秒还连不上就重试
    setTimeout(() => { if (this.ctl === ctl && !this.connected) lost(); }, 10000);
  }
  send(msg) { if (this.ctl?.open) try { this.ctl.send(msg); } catch {} }
}


// ---------------- 备用通道：Trystero（通过多个公共 Nostr 中继配对，PeerJS 服务器出问题时用） ----------------
function trysteroConfig() {
  const cfg = { appId: 'soundmesh.alloong.github.io', identity: 'none', rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };
  const relay = new URLSearchParams(location.search).get('relay'); // 测试用：指定中继
  if (relay) cfg.relayConfig = { urls: [relay], redundancy: 1 };
  return cfg;
}

export class TrysteroHostLink extends EventTarget {
  constructor(code) {
    super();
    this.clients = new Map();
    this.code = code;
    this.start();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  start() {
    if (!window.Trystero) return;
    try { this.room = window.Trystero.joinRoom(trysteroConfig(), 'sm-' + this.code.toLowerCase()); } catch (e) { this.emit('status', 'error:trystero'); return; }
    const room = this.room;
    this.ctl = room.makeAction('ctl');
    this.bin = room.makeAction('bin');
    room.onPeerJoin(({ peerId }) => {
      const c = { did: null, peer: peerId, link: this, via: 'backup', pending: 0, open: true };
      this.clients.set('tr:' + peerId, c);
      this.ctl.send({ t: 'iamhost' }, { target: peerId }).catch(() => {});
      this.emit('peers');
    });
    room.onPeerLeave(({ peerId }) => { this.clients.delete('tr:' + peerId); this.emit('peers'); });
    this.ctl.onMessage((data, { peerId }) => {
      const c = this.clients.get('tr:' + peerId);
      if (!c) return;
      if (data && data.t === 'hello') c.did = String(data.did || '').slice(0, 20);
      this.emit('msg', { from: peerId, client: c, msg: data });
    });
  }
  restartWithCode(code) { try { this.room?.leave(); } catch {} this.clients.clear(); this.code = code; this.start(); }
  send(c, msg) { this.ctl?.send(msg, { target: c.peer }).catch(() => {}); }
  sendBin(c, buf) {
    if (!this.bin) return false;
    const u = new Uint8Array(buf);
    c.pending += u.byteLength;
    this.bin.send(u, { target: c.peer }).catch(() => {}).finally(() => { c.pending -= u.byteLength; });
    return true;
  }
  buffered(c) { return c.pending || 0; }
}

// 控制端同时开两条入口：PeerJS（主）+ Trystero（备用），设备从哪条连进来都行
export class MultiHostLink extends EventTarget {
  constructor(code) {
    super();
    this.links = [new HostLink(code)];
    if (window.Trystero) this.links.push(new TrysteroHostLink(code));
    for (const l of this.links) for (const ev of ['msg', 'peers']) l.addEventListener(ev, (e) => this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })));
    this.links[0].addEventListener('status', (e) => this.dispatchEvent(new CustomEvent('status', { detail: e.detail })));
  }
  get clients() {
    const m = new Map();
    for (const l of this.links) for (const [k, c] of l.clients) m.set(k, c);
    return m;
  }
  restartWithCode(code) { this.links.forEach((l) => l.restartWithCode(code)); }
  send(c, msg) { c.link.send(c, msg); }
  sendBin(c, buf) { return c.link.sendBin(c, buf); }
  buffered(c) { return c.link.buffered(c); }
  broadcast(msg) { for (const c of this.clients.values()) if (c.did) this.send(c, msg); }
  isOpen(c) { return c.via === 'backup' ? true : !!c.ctl?.open; }
}

export class TrysteroNodeLink extends EventTarget {
  constructor(code, helloFn) {
    super();
    this.code = code; this.helloFn = helloFn;
    this.connected = false; this.host = null; this.via = 'backup';
    try { this.room = window.Trystero.joinRoom(trysteroConfig(), 'sm-' + code.toLowerCase()); } catch { setTimeout(() => this.emit('status', 'signal-error')); return; }
    this.ctl = this.room.makeAction('ctl');
    this.bin = this.room.makeAction('bin');
    this.emit('status', 'connecting');
    this.ctl.onMessage((data, { peerId }) => {
      if (data?.t === 'iamhost') {
        if (this.host !== peerId) { this.host = peerId; this.connected = true; this.send(this.helloFn()); this.emit('status', 'open'); }
        return;
      }
      if (peerId === this.host) this.emit('msg', data);
    });
    this.bin.onMessage((data, { peerId }) => {
      if (peerId !== this.host) return;
      const u = data instanceof Uint8Array ? data : new Uint8Array(data);
      this.emit('bin', unpackBin(u));
    });
    this.room.onPeerLeave(({ peerId }) => {
      if (peerId === this.host) { this.host = null; this.connected = false; this.emit('status', 'lost'); }
    });
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  send(msg) { if (this.host) this.ctl.send(msg, { target: this.host }).catch(() => {}); }
  close() { try { this.room?.leave(); } catch {} }
}

// 播放节点：先用 PeerJS；6 秒还连不上（或断线后 6 秒没恢复），自动改走备用通道
export class AutoNodeLink extends EventTarget {
  constructor(code, helloFn) {
    super();
    this.code = code; this.helloFn = helloFn;
    this.use(new NodeLink(code, helloFn));
    this.armFallback();
  }
  get connected() { return !!this.cur?.connected; }
  get via() { return this.cur?.via; }
  use(link) {
    this.cur = link;
    for (const ev of ['msg', 'bin']) link.addEventListener(ev, (e) => { if (this.cur === link) this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })); });
    link.addEventListener('status', (e) => {
      if (this.cur !== link) return;
      this.dispatchEvent(new CustomEvent('status', { detail: e.detail }));
      if (e.detail === 'open') { clearTimeout(this.fbTimer); this.fbTimer = null; }
      else if (!link.connected && !this.fbTimer) this.armFallback(); // 已经在倒计时就不要重置
    });
  }
  armFallback() {
    clearTimeout(this.fbTimer);
    this.fbTimer = setTimeout(() => {
      this.fbTimer = null;
      if (this.cur.connected || !window.Trystero) return;
      const old = this.cur;
      const next = old.via === 'peerjs' ? new TrysteroNodeLink(this.code, this.helloFn) : new NodeLink(this.code, this.helloFn);
      old.close();
      this.use(next);
      this.dispatchEvent(new CustomEvent('status', { detail: next.via === 'backup' ? 'fallback' : 'connecting' }));
      this.armFallback();
    }, 6000);
  }
  send(msg) { this.cur.send(msg); }
  // 连接“假死”（Wi-Fi 闪断后浏览器还以为连着）：立刻换一条新连接，不等浏览器 30 秒后才发现
  kick() {
    const old = this.cur, next = new old.constructor(this.code, this.helloFn);
    old.close();
    this.use(next);
    this.dispatchEvent(new CustomEvent('status', { detail: 'lost' }));
    this.armFallback();
  }
}
