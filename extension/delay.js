// 在 YouTube 页面里运行：在原视频上盖一层画布，显示“D 毫秒以前”的画面，
// 让画面和 SoundMesh 播到手机/平板上的声音对齐。点击、全屏、字幕都照常（画布不拦截鼠标）。
(() => {
  let cfg = { enabled: true, trim: 0 }, info = null;
  const load = (r) => { if (r.smCfg) cfg = { ...cfg, ...r.smCfg }; if (r.smDelay) info = r.smDelay; };
  try {
    chrome.storage.local.get(['smCfg', 'smDelay'], load);
    chrome.storage.onChanged.addListener((ch) => { if (ch.smCfg) cfg = { ...cfg, ...ch.smCfg.newValue }; if (ch.smDelay) info = ch.smDelay.newValue; });
  } catch {}

  const delayMs = () => {
    if (!cfg.enabled || !info || !info.live || Date.now() - info.t > 4000) return 0;
    return Math.max(0, Math.min(3000, (info.ms || 0) + (cfg.trim || 0)));
  };

  let video = null, canvas = null, ctx = null, queue = [], shown = null, broken = false, cbId = 0;

  const clear = () => { for (const f of queue) f.bmp.close?.(); queue = []; if (canvas) canvas.style.display = 'none'; shown = null; };

  function attach(v) {
    if (video === v) return;
    if (video && cbId) video.cancelVideoFrameCallback?.(cbId);
    clear(); canvas?.remove();
    video = v; broken = false;
    canvas = document.createElement('canvas');
    canvas.className = 'soundmesh-delay';
    canvas.style.cssText = 'position:absolute;pointer-events:none;display:none;background:#000;';
    v.after(canvas);
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    const onFrame = (now, meta) => {
      cbId = v.requestVideoFrameCallback(onFrame);
      if (broken || delayMs() <= 15) return;
      const t = meta?.expectedDisplayTime || now;
      createImageBitmap(v).then((bmp) => {
        queue.push({ t, bmp });
        while (queue.length > 240) queue.shift().bmp.close?.();
      }).catch(() => { broken = true; clear(); }); // 受保护的视频（付费电影等）拿不到画面，就不延后
    };
    cbId = v.requestVideoFrameCallback(onFrame);
  }

  function findVideo() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video') || document.querySelector('video');
    if (v && 'requestVideoFrameCallback' in v) attach(v);
  }
  setInterval(findVideo, 1000); findVideo();

  function draw() {
    requestAnimationFrame(draw);
    if (!video || !canvas) return;
    const D = delayMs();
    if (D <= 15 || broken) { if (queue.length || canvas.style.display !== 'none') clear(); return; }
    const target = performance.now() - D;
    let pick = null;
    while (queue.length && queue[0].t <= target) { if (pick) pick.bmp.close?.(); pick = queue.shift(); }
    // 跟着原视频的位置和大小走（全屏、影院模式、小窗都对得上）
    const s = canvas.style, l = video.offsetLeft + 'px', tp = video.offsetTop + 'px', w = video.clientWidth + 'px', h = video.clientHeight + 'px';
    if (s.left !== l) s.left = l; if (s.top !== tp) s.top = tp; if (s.width !== w) s.width = w; if (s.height !== h) s.height = h;
    if (!pick) return;
    if (canvas.width !== pick.bmp.width || canvas.height !== pick.bmp.height) { canvas.width = pick.bmp.width; canvas.height = pick.bmp.height; }
    ctx.drawImage(pick.bmp, 0, 0, canvas.width, canvas.height);
    shown?.bmp.close?.(); shown = pick;
    if (s.display === 'none') s.display = 'block';
  }
  requestAnimationFrame(draw);

  // 给弹窗看现在的状态
  setInterval(() => { try { chrome.storage.local.set({ smYt: { t: Date.now(), on: !!(canvas && canvas.style.display !== 'none'), broken, D: delayMs() } }); } catch {} }, 1000);
})();
