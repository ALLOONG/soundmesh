// 同步歌词：从 LRCLIB（免费开放的歌词库）搜索，解析 LRC 时间轴

const LRCLIB = 'https://lrclib.net/api/search';
const CLIENT = 'SoundMesh v0.4 (https://github.com/ALLOONG/soundmesh)';

export async function searchLyrics(q) {
  const url = `${LRCLIB}?q=${encodeURIComponent(q)}`;
  let res;
  try { res = await fetch(url, { headers: { 'Lrclib-Client': CLIENT } }); } catch { res = null; }
  if (!res || !res.ok) res = await fetch(url); // 自定义请求头被拦时，退回普通请求
  if (res.status === 429) throw new Error('歌词库请求太频繁，请稍等一分钟再试');
  if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error('歌词库暂时连不上');
  const list = await res.json();
  return list.filter((x) => !x.instrumental && (x.syncedLyrics || x.plainLyrics)).slice(0, 12).map((x) => ({
    id: x.id, title: x.trackName, artist: x.artistName, album: x.albumName, duration: x.duration,
    synced: !!x.syncedLyrics, text: x.syncedLyrics || x.plainLyrics,
  }));
}

// "[01:23.45]歌词" -> { t: 83.45, text }；一行多个时间戳也支持；没有时间轴的纯文本歌词 t 为 null
export function parseLRC(text, synced) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!synced) { if (raw.trim()) lines.push({ t: null, text: raw.trim() }); continue; }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text: body });
  }
  if (synced) lines.sort((a, b) => a.t - b.t);
  return lines.slice(0, 400).map((l) => ({ t: l.t === null ? null : Math.round(l.t * 100) / 100, text: l.text.slice(0, 200) }));
}

// 当前歌曲位置（秒）对应的歌词行号
export function lineAt(lines, pos) {
  if (pos === null || !lines.length || lines[0].t === null) return -1;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].t <= pos) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
