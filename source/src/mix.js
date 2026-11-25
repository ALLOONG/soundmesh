// 混音计划计算：输入房间状态，输出每台设备该怎么出声。
// 纯函数，服务器和浏览器共用。坐标单位为米，画布上方 (y=0) 是“前方/舞台”。

export const SPEED_OF_SOUND = 343; // m/s

export const TYPE_RANK = { computer: 3, tablet: 2, phone: 1 };

// 多声道文件的标准声道方位（度，0=正前方，正值=右）
const CHANNEL_LAYOUTS = {
  1: [{ name: 'M', az: 0 }],
  2: [{ name: 'L', az: -30 }, { name: 'R', az: 30 }],
  4: [{ name: 'L', az: -30 }, { name: 'R', az: 30 }, { name: 'Ls', az: -110 }, { name: 'Rs', az: 110 }],
  6: [
    { name: 'L', az: -30 }, { name: 'R', az: 30 }, { name: 'C', az: 0 },
    { name: 'LFE', az: null }, { name: 'Ls', az: -110 }, { name: 'Rs', az: 110 },
  ],
  8: [
    { name: 'L', az: -30 }, { name: 'R', az: 30 }, { name: 'C', az: 0 }, { name: 'LFE', az: null },
    { name: 'Ls', az: -110 }, { name: 'Rs', az: 110 }, { name: 'Lb', az: -150 }, { name: 'Rb', az: 150 },
  ],
};

export function channelLayout(n) {
  if (CHANNEL_LAYOUTS[n]) return CHANNEL_LAYOUTS[n];
  // 未知声道数：均匀铺在前方半圆
  return Array.from({ length: n }, (_, i) => ({ name: `Ch${i + 1}`, az: n === 1 ? 0 : -90 + (180 * i) / (n - 1) }));
}

export const BAND_LABELS = { full: '全频', low: '低频', mid: '中频', high: '高频', midhigh: '中高频' };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 设备相对听众的几何关系
export function geometry(dev, listener) {
  const dx = dev.x - listener.x;
  const dy = listener.y - dev.y; // 正值 = 在听众前方
  const d = Math.max(0.3, Math.hypot(dx, dy));
  const az = (Math.atan2(dx, dy) * 180) / Math.PI; // 0 = 正前方
  return { d, az, pan: clamp(dx / d, -1, 1) };
}

function angleDiff(a, b) {
  let x = Math.abs(a - b) % 360;
  return x > 180 ? 360 - x : x;
}

function bandFilters(band, room) {
  const lo = room.bands?.lowCut ?? 150;
  const hi = room.bands?.highCut ?? 2500;
  switch (band) {
    case 'low': return [{ type: 'lowpass', freq: lo }];
    case 'mid': return [{ type: 'highpass', freq: lo }, { type: 'lowpass', freq: hi }];
    case 'high': return [{ type: 'highpass', freq: hi }];
    case 'midhigh': return [{ type: 'highpass', freq: lo }];
    default: return [];
  }
}

// 判定“低音设备”：用户标记了 bass，否则选类型最大的那台
function pickBassDevices(devs) {
  const flagged = devs.filter((d) => d.caps?.bass);
  if (flagged.length) return flagged;
  if (devs.length < 2) return [];
  const best = [...devs].sort((a, b) => (TYPE_RANK[b.type] || 0) - (TYPE_RANK[a.type] || 0))[0];
  return [best];
}

function guessRole(name = '') {
  const n = name.toLowerCase();
  if (/vocal|voice|vox|人声|歌声|主唱/.test(n)) return 'vocals';
  if (/bass|贝斯|低音/.test(n)) return 'bass';
  if (/drum|perc|鼓|打击/.test(n)) return 'drums';
  if (/piano|key|钢琴|键盘/.test(n)) return 'piano';
  if (/guitar|吉他/.test(n)) return 'guitar';
  return 'other';
}
export { guessRole };

// 'mix' 轨道 = 完整混音（实时音源拆声部时同时提供完整混音和各声部）
const stemTracks = (g) => g.tracks.filter((t) => t.role !== 'mix');
const mixTracks = (g) => (g.tracks.some((t) => t.role === 'mix') ? g.tracks.filter((t) => t.role === 'mix') : g.tracks);

// ---------- 自动分配（声音分工） ----------

function autoAssignStems(devs, group, geo) {
  const out = new Map(devs.map((d) => [d.id, []]));
  if (!devs.length) return out;
  const tracks = stemTracks(group);
  const free = new Set(devs.map((d) => d.id));
  const take = (id, key) => { out.get(id).push(key); free.delete(id); };
  const byFront = [...devs].sort((a, b) => Math.abs(geo[a.id].az) - Math.abs(geo[b.id].az));
  const bassDevs = pickBassDevices(devs);

  const order = { vocals: 0, bass: 1, drums: 2 };
  const sorted = [...tracks].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9));
  const rest = [];
  for (const t of sorted) {
    const key = `track:${t.id}`;
    if (t.role === 'vocals') {
      const d = byFront.find((x) => free.has(x.id)) || byFront[0];
      take(d.id, key);
    } else if (t.role === 'bass' && bassDevs.length) {
      const d = bassDevs.find((x) => free.has(x.id)) || bassDevs[0];
      take(d.id, key);
    } else rest.push(key);
  }
  // 其余轨道：从左到右分给剩下的设备
  const leftToRight = (ids) => ids.sort((a, b) => geo[a].az - geo[b].az);
  let freeIds = leftToRight([...free]);
  rest.forEach((key) => {
    if (freeIds.length) take(freeIds.shift(), key);
    else {
      // 设备不够：给当前轨道最少的设备
      const hasVox = (id) => (out.get(id).some((k) => tracks.find((t) => `track:${t.id}` === k)?.role === 'vocals') ? 1 : 0);
      const d = [...devs].sort((a, b) => out.get(a.id).length - out.get(b.id).length || hasVox(a.id) - hasVox(b.id))[0];
      out.get(d.id).push(key);
    }
  });
  // 设备多于轨道：空闲设备重复播放非人声/非低音轨道，或者全部轨道
  freeIds = leftToRight([...free]);
  const dupPool = rest.length ? rest : sorted.map((t) => `track:${t.id}`);
  freeIds.forEach((id, i) => out.get(id).push(dupPool[i % dupPool.length]));
  return out;
}

function autoAssignBands(devs, geo) {
  const out = new Map();
  if (devs.length === 1) { out.set(devs[0].id, ['band:full']); return out; }
  const bassDevs = pickBassDevices(devs);
  const bassIds = new Set(bassDevs.map((d) => d.id));
  bassDevs.forEach((d) => out.set(d.id, ['band:low']));
  const others = devs.filter((d) => !bassIds.has(d.id)).sort((a, b) => geo[a.id].d - geo[b.id].d);
  if (others.length === 1) out.set(others[0].id, ['band:midhigh']);
  else others.forEach((d, i) => out.set(d.id, [i % 2 === 0 ? 'band:high' : 'band:mid'])); // 离听众最近的给高频
  return out;
}

function autoAssignChannels(devs, group, geo) {
  const out = new Map(devs.map((d) => [d.id, []]));
  if (!devs.length) return out;
  const n = group.tracks[0]?.channels || 2;
  const layout = channelLayout(n);
  const bassDevs = pickBassDevices(devs);
  layout.forEach((ch, idx) => {
    if (ch.az === null) { // LFE
      (bassDevs.length ? bassDevs : [devs[0]]).forEach((d) => out.get(d.id).push(`ch:${idx}`));
    }
  });
  // 每台设备选方位最近的声道
  for (const d of devs) {
    let best = -1, bestDiff = Infinity;
    layout.forEach((ch, idx) => {
      if (ch.az === null) return;
      const diff = angleDiff(geo[d.id].az, ch.az);
      if (diff < bestDiff) { bestDiff = diff; best = idx; }
    });
    if (best >= 0) out.get(d.id).push(`ch:${best}`);
  }
  // 没人负责的声道：交给方位最近的设备
  layout.forEach((ch, idx) => {
    if (ch.az === null) return;
    const key = `ch:${idx}`;
    if ([...out.values()].some((arr) => arr.includes(key))) return;
    const d = [...devs].sort((a, b) => angleDiff(geo[a.id].az, ch.az) - angleDiff(geo[b.id].az, ch.az))[0];
    out.get(d.id).push(key);
  });
  return out;
}

// 可供手动绑定的选项（给 UI 用）
export function assignOptions(room) {
  const group = room.library.find((g) => g.id === room.currentGroupId);
  if (!group) return [];
  const split = splitKind(room, group);
  if (split === 'stems') return stemTracks(group).map((t) => ({ key: `track:${t.id}`, label: t.name }));
  if (split === 'channels') return channelLayout(group.tracks[0]?.channels || 2).map((c, i) => ({ key: `ch:${i}`, label: `声道 ${c.name}` }));
  return Object.entries(BAND_LABELS).map(([k, v]) => ({ key: `band:${k}`, label: v }));
}

// 分工模式实际用哪种方式
export function splitKind(room, group) {
  if (!group) return 'bands';
  const pref = room.splitPreset || 'auto';
  if (pref === 'bands') return 'bands';
  if (pref === 'stems' && stemTracks(group).length > 1) return 'stems';
  if (pref === 'channels' && (group.tracks[0]?.channels || 0) > 2) return 'channels';
  if (stemTracks(group).length > 1) return 'stems';
  if ((group.tracks[0]?.channels || 0) > 2) return 'channels';
  return 'bands';
}

// ---------- 主函数 ----------

// ---------- 乐团模式 ----------
// 设备特长：测过就用测的；没测过按设备类型估（手机小喇叭低音最少，电脑/平板好一些）
export function capOf(d) {
  if (d.cap?.measured) return d.cap;
  const t = { phone: { low: 350, high: 14000, bass: -18 }, tablet: { low: 180, high: 15000, bass: -10 }, computer: { low: 110, high: 16000, bass: -6 } }[d.type] || { low: 180, high: 15000, bass: -10 };
  return d.caps?.bass ? { ...t, low: 60, bass: 0 } : t;
}
export const BAND_PARTS = { vocals: '🎤 人声', drums: '🥁 鼓', bass: '🎸 低音', other: '🎹 伴奏' };

// 每个声部分给哪些设备、各占多少：
//   低音 → 低音最足的设备（几乎全给它）
//   人声 → 正前方/中间的设备（像主唱站在中间）
//   伴奏 → 左右两边的设备（拉开宽度）
//   鼓   → 低音和高音都不错、靠中间的设备
// 每个声部在所有设备上的份量加起来正好 = 1，所以大家合起来就是完整的原曲，不会“分开”；
// “融合度”再让每台都带一点完整的歌，听起来更像一个整体。
export function bandWeights(room, devs, geo) {
  const out = new Map();
  if (!devs.length) return out;
  const caps = devs.map((d) => capOf(d));
  const bassFit = caps.map((c) => clamp((420 - c.low) / 360, 0.03, 1));
  const trebFit = caps.map((c) => clamp((c.high - 6000) / 10000, 0.2, 1));
  const bMax = Math.max(...bassFit), tMax = Math.max(...trebFit);
  const near = (az, center, width) => Math.exp(-(((angleDiff(az, center)) / width) ** 2));
  const raw = { vocals: [], drums: [], bass: [], other: [] };
  devs.forEach((d, i) => {
    const az = geo[d.id].az, b = bassFit[i] / bMax, t = trebFit[i] / tMax;
    raw.bass.push(b ** 4);
    raw.vocals.push(near(az, 0, 20) * (0.4 + 0.6 * t) + 0.02);
    raw.drums.push(((b + t) / 2) ** 2 * (0.5 + 0.5 * near(az, 0, 60)) + 0.02);
    raw.other.push((0.25 + 0.75 * Math.min(1, Math.abs(az) / 50)) * (0.5 + 0.5 * t) + 0.02);
  });
  const g = devs.length === 1 ? 1 : clamp(room.bandGlue ?? 0.25, 0, 1);
  const w = {};
  for (const part of Object.keys(raw)) {
    const sum = raw[part].reduce((a, v) => a + v, 0) || 1;
    w[part] = raw[part].map((v) => (1 - g) * (v / sum) + g / devs.length);
  }
  // 立体声也按位置分：左边的设备多放左声道、右边的多放右声道（像乐手站在舞台左右）。
  // 每个声部的左声道在所有设备上加起来 = 1，右声道也是 = 1 → 合起来仍是完整的原曲
  const spread = clamp(room.bandSpread ?? 0.8, 0, 1);
  const pans = devs.map((d) => geo[d.id].pan);
  const lr = {};
  for (const part of Object.keys(w)) {
    const l = w[part].map((v, i) => v * (1 - spread * pans[i])), r = w[part].map((v, i) => v * (1 + spread * pans[i]));
    const sl = l.reduce((a, v) => a + v, 0) || 1, sr = r.reduce((a, v) => a + v, 0) || 1;
    lr[part] = devs.map((_, i) => [l[i] / sl, r[i] / sr]);
  }
  devs.forEach((d, i) => out.set(d.id, {
    vocals: w.vocals[i], drums: w.drums[i], bass: w.bass[i], other: w.other[i],
    lr: { vocals: lr.vocals[i], drums: lr.drums[i], bass: lr.bass[i], other: lr.other[i] },
  }));
  return out;
}

export function computeMix(room) {
  const plans = {};
  const group = room.library.find((g) => g.id === room.currentGroupId) || null;
  const devs = Object.values(room.devices).filter((d) => d.online);
  const listener = room.listener;
  const opt = room.options || {};
  const geo = {};
  for (const d of devs) geo[d.id] = geometry(d, listener);
  if (!devs.length) return plans;

  const ds = devs.map((d) => geo[d.id].d);
  const dmax = Math.max(...ds), dmin = Math.min(...ds);

  // 1) 每台设备的自动增益与延迟
  const base = {};
  for (const d of devs) {
    const g = geo[d.id];
    let gain = 1;
    if (opt.distanceGain) {
      if (room.gainPreset === 'focus') gain = Math.pow(dmin / g.d, 1.5); // 近的更响
      else gain = g.d / dmax; // 平衡：近的减小，到听众位响度一致
    }
    const delayMs = opt.distanceDelay ? ((dmax - g.d) / SPEED_OF_SOUND) * 1000 : 0;
    base[d.id] = { gain: clamp(gain, 0.05, 1), delayMs, pan: g.pan };
  }

  // 2) 分配声源
  const band = group?.kind === 'live' && room.mode === 'band' ? bandWeights(room, devs, geo) : null;
  let autoAssign = new Map();
  let split = null;
  const manual = {};
  if (group && room.mode === 'split') {
    split = splitKind(room, group);
    const valid = new Set(assignOptions(room).map((o) => o.key));
    // 手动绑定只在当前曲目/分工方式下有效；换了曲目后失效的绑定自动忽略
    for (const d of devs) manual[d.id] = d.override?.locked ? (d.override.assign || []).filter((k) => valid.has(k)) : [];
    const auto = devs.filter((d) => !manual[d.id].length);
    if (split === 'stems') autoAssign = autoAssignStems(auto, group, geo);
    else if (split === 'channels') autoAssign = autoAssignChannels(auto, group, geo);
    else autoAssign = autoAssignBands(auto, geo);
  }

  for (const d of devs) {
    const ov = d.override || {};
    const b = base[d.id];
    const pan = ov.pan ?? b.pan;
    const width = opt.stereo ? clamp(room.stereoWidth ?? 1, 0, 1) : 0;
    const lr = { type: 'lr', wl: (1 - pan * width) / 2, wr: (1 + pan * width) / 2 };
    const stereoMix = opt.stereo ? lr : { type: 'stereo' };
    let sources = [];
    let assign = [];

    if (group) {
      if (band) {
        // 乐团模式：控制端已经按这台设备的角色混好一份专属的声音（每台不一样）
        const bt = group.tracks.find((t) => t.role === 'band');
        if (bt) sources = [{ trackId: bt.id, mix: { type: 'stereo' }, filters: [] }]; // 左右已经在控制端按位置分好了
        assign = ['band'];
      } else if (room.mode !== 'split') {
        // 协同播放：所有轨道一起出
        sources = mixTracks(group).map((t) => ({ trackId: t.id, mix: stereoMix, filters: [] }));
        assign = ['all'];
      } else {
        assign = manual[d.id]?.length ? manual[d.id] : autoAssign.get(d.id) || [];
        for (const key of assign) {
          const [kind, val] = key.split(':');
          if (kind === 'track') {
            if (group.tracks.some((t) => t.id === val)) sources.push({ trackId: val, mix: stereoMix, filters: [] });
          } else if (kind === 'ch') {
            const t = group.tracks[0];
            if (t) sources.push({ trackId: t.id, mix: { type: 'ch', index: Number(val) }, filters: [] });
          } else if (kind === 'band') {
            for (const t of mixTracks(group)) sources.push({ trackId: t.id, mix: stereoMix, filters: bandFilters(val, room) });
          }
        }
      }
    }

    const autoGain = ov.gain ?? b.gain;
    const vol = d.muted ? 0 : (d.volume ?? 1);
    plans[d.id] = {
      gain: autoGain * vol * (room.masterVolume ?? 1),
      autoGain,
      pan,
      delayMs: ov.delayMs ?? b.delayMs,
      distance: geo[d.id].d,
      azimuth: geo[d.id].az,
      split,
      assign,
      sources,
      band: band ? band.get(d.id) : null,
    };
  }
  return plans;
}

// 把分配 key 转成人能看懂的标签
export function assignLabel(room, key) {
  if (key === 'all') return '全部';
  if (key === 'band') return '乐团角色';
  const group = room.library.find((g) => g.id === room.currentGroupId);
  const [kind, val] = key.split(':');
  if (kind === 'track') return group?.tracks.find((t) => t.id === val)?.name || '轨道';
  if (kind === 'ch') return `声道 ${channelLayout(group?.tracks[0]?.channels || 2)[Number(val)]?.name || val}`;
  if (kind === 'band') return BAND_LABELS[val] || val;
  return key;
}
