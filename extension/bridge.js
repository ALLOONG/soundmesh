// 在 SoundMesh 主机页面里运行：把“画面该延后多少”转交给 YouTube 页面
document.documentElement.dataset.smExt = '1';
window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.__soundmesh !== 'videoDelay') return;
  try { chrome.storage.local.set({ smDelay: { ms: d.ms, live: d.live, t: Date.now() } }); } catch {}
});
