// 内置演示音频：在每台设备上用同样的算法合成，不需要上传文件。
// 演示曲：120 BPM，16 小节（32 秒）循环，Am - F - C - G，分成 旋律/鼓/贝斯/和弦 4 轨。

const BPM = 120;
const BEAT = 60 / BPM;
const BARS = 16;
const DEMO_LEN = BARS * 4 * BEAT; // 32 秒
const CHORDS = [ // 每 2 小节换一个和弦（MIDI 音高）
  [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
];
const ROOTS = [45, 41, 36, 43];
const MELODY = [ // [拍位置(0-31, 以 2 小节为一句), 音高, 时值(拍)]
  [0, 76, 1], [1, 74, 0.5], [1.5, 72, 0.5], [2, 69, 1.5], [4, 72, 1], [5, 74, 1], [6, 76, 2],
  [8, 77, 1], [9, 76, 0.5], [9.5, 74, 0.5], [10, 72, 1.5], [12, 69, 1], [13, 72, 1], [14, 69, 2],
  [16, 72, 1], [17, 74, 1], [18, 76, 1], [19, 79, 1], [20, 76, 2], [22, 74, 2],
  [24, 74, 1], [25, 72, 0.5], [25.5, 71, 0.5], [26, 74, 1.5], [28, 71, 1], [29, 69, 1], [30, 67, 2],
];
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

function rng(seed) { // 确定性随机数：每台设备合成结果一模一样
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

function synthDrums(sr) {
  const n = Math.round(DEMO_LEN * sr), d = new Float32Array(n), noise = rng(7);
  const beats = BARS * 4;
  for (let b = 0; b < beats; b++) {
    const t0 = Math.round(b * BEAT * sr);
    const beatInBar = b % 4;
    if (beatInBar === 0 || beatInBar === 2 || (b % 8 === 7)) { // 底鼓
      const off = b % 8 === 7 ? Math.round(0.5 * BEAT * sr) : 0;
      let ph = 0;
      for (let i = 0; i < 0.35 * sr; i++) {
        const t = i / sr, f = 45 + 90 * Math.exp(-t * 25);
        ph += (2 * Math.PI * f) / sr;
        const k = t0 + off + i; if (k < n) d[k] += Math.sin(ph) * Math.exp(-t * 9) * 0.9;
      }
    }
    if (beatInBar === 1 || beatInBar === 3) { // 军鼓
      for (let i = 0; i < 0.2 * sr; i++) {
        const t = i / sr, k = t0 + i; if (k >= n) break;
        d[k] += (noise() * 0.5 + Math.sin(2 * Math.PI * 190 * t) * 0.35) * Math.exp(-t * 22);
      }
    }
    for (const h of [0, 0.5]) { // 踩镲（八分音符）
      const s0 = t0 + Math.round(h * BEAT * sr);
      let prev = 0;
      for (let i = 0; i < 0.05 * sr; i++) {
        const k = s0 + i; if (k >= n) break;
        const x = noise(), hp = x - prev; prev = x;
        d[k] += hp * Math.exp(-(i / sr) * 70) * (h ? 0.13 : 0.2);
      }
    }
  }
  return [d];
}

function synthBass(sr) {
  const n = Math.round(DEMO_LEN * sr), d = new Float32Array(n);
  for (let e = 0; e < BARS * 8; e++) { // 八分音符
    const chord = Math.floor(e / 16) % 4;
    const note = ROOTS[chord] + (e % 8 === 6 ? 12 : 0);
    const f = midi(note), t0 = Math.round(e * 0.5 * BEAT * sr), len = Math.round(0.45 * BEAT * sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr, k = t0 + i; if (k >= n) break;
      const env = Math.min(1, t * 200) * Math.exp(-t * 3);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h * 0.8 + 0.2);
      d[k] += v * env * 0.32;
    }
  }
  return [d];
}

function synthChords(sr) {
  const n = Math.round(DEMO_LEN * sr), d = new Float32Array(n);
  const seg = 8 * BEAT;
  for (let c = 0; c < BARS / 2; c++) {
    const notes = CHORDS[c % 4], t0 = Math.round(c * seg * sr), len = Math.round(seg * sr);
    for (let i = 0; i < len; i++) {
      const t = i / sr, k = t0 + i; if (k >= n) break;
      const env = Math.min(1, t * 4) * Math.min(1, (seg - t) * 6);
      let v = 0;
      for (const m of notes) { const f = midi(m); v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2.003 * t); }
      // 每拍轻微律动
      const pulse = 0.75 + 0.25 * Math.cos((2 * Math.PI * t) / BEAT);
      d[k] += v * env * pulse * 0.07;
    }
  }
  return [d];
}

function synthMelody(sr) {
  const n = Math.round(DEMO_LEN * sr), d = new Float32Array(n);
  for (let phrase = 0; phrase < BARS / 8; phrase++) {
    for (const [pos, note, dur] of MELODY) {
      const f = midi(note), t0 = Math.round((phrase * 32 + pos) * BEAT * sr), len = Math.round(dur * BEAT * sr * 0.95);
      let ph = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, k = t0 + i; if (k >= n) break;
        const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3);
        ph += (2 * Math.PI * f * vib) / sr;
        const env = Math.min(1, t * 60) * Math.min(1, (len - i) / (0.03 * sr)) * (0.7 + 0.3 * Math.exp(-t * 4));
        d[k] += (Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph)) * env * 0.28;
      }
    }
  }
  return [d];
}

function synthMix(sr) { // 立体声完整混音
  const parts = { drums: synthDrums(sr)[0], bass: synthBass(sr)[0], chords: synthChords(sr)[0], melody: synthMelody(sr)[0] };
  const n = parts.drums.length, L = new Float32Array(n), R = new Float32Array(n);
  const pan = { drums: 0, bass: 0, chords: -0.6, melody: 0.45 };
  const delay = Math.round(0.012 * sr); // 和弦做一点宽度
  for (const [k, buf] of Object.entries(parts)) {
    const p = pan[k], gl = Math.cos(((p + 1) * Math.PI) / 4) * 1.2, gr = Math.sin(((p + 1) * Math.PI) / 4) * 1.2;
    for (let i = 0; i < n; i++) {
      L[i] += buf[i] * gl;
      R[i] += (k === 'chords' && i >= delay ? buf[i - delay] * 0.9 + buf[i] * 0.3 : buf[i]) * gr;
    }
  }
  return [L, R];
}

function synthClick(sr) {
  const d = new Float32Array(sr * 2);
  for (let beat = 0; beat < 4; beat++) {
    const f = beat === 0 ? 1760 : 1100, start = Math.floor(beat * 0.5 * sr);
    for (let i = 0; i < 0.03 * sr; i++) d[start + i] = Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (0.006 * sr)) * 0.9;
  }
  return [d];
}

const SYNTHS = { drums: synthDrums, bass: synthBass, chords: synthChords, melody: synthMelody, mix: synthMix, click: synthClick };

export function synthBuffer(ctx, name) {
  const fn = SYNTHS[name];
  if (!fn) throw new Error('未知的内置音频 ' + name);
  const chans = fn(ctx.sampleRate);
  const buf = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((c, i) => {
    let peak = 0; for (let j = 0; j < c.length; j++) peak = Math.max(peak, Math.abs(c[j]));
    if (peak > 0.98) for (let j = 0; j < c.length; j++) c[j] *= 0.98 / peak; // 防削波
    buf.copyToChannel(c, i);
  });
  return buf;
}

export const BUILTIN_GROUPS = [
  { id: 'demo-mix', name: '演示曲（立体声）', kind: 'synth', loop: true, duration: DEMO_LEN,
    tracks: [{ id: 'mix', name: '完整混音', src: 'synth:mix', channels: 2, duration: DEMO_LEN, role: 'other' }] },
  { id: 'demo-stems', name: '演示曲（4 轨分轨）', kind: 'synth', loop: true, duration: DEMO_LEN,
    tracks: [
      { id: 'mel', name: '旋律', src: 'synth:melody', channels: 1, duration: DEMO_LEN, role: 'vocals' },
      { id: 'drm', name: '鼓', src: 'synth:drums', channels: 1, duration: DEMO_LEN, role: 'drums' },
      { id: 'bas', name: '贝斯', src: 'synth:bass', channels: 1, duration: DEMO_LEN, role: 'bass' },
      { id: 'chd', name: '和弦', src: 'synth:chords', channels: 1, duration: DEMO_LEN, role: 'other' },
    ] },
  { id: 'click', name: '节拍器（对齐测试）', kind: 'synth', loop: true, duration: 2,
    tracks: [{ id: 'click', name: '节拍', src: 'synth:click', channels: 1, duration: 2, role: 'other' }] },
];
