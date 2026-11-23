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
      const c = this.clients.get(conn.peer) || { did: null, ctl: null, bin: null };
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
    this.start();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  start() {
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
      if (this.connected) return;
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
