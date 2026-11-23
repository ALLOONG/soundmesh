// 在 SoundMesh 主机页面里运行：把“画面该延后多少”转交给 YouTube 页面
document.documentElement.dataset.smExt = '1';
window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.__soundmesh !== 'videoDelay') return;
  try { chrome.storage.local.set({ smDelay: { ms: d.ms, live: d.live, t: Date.now() } }); } catch {}
});
// 扩展弹窗送来的“分页声音”通行证，转交给 SoundMesh 页面
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.type === 'tabStream') { window.postMessage({ __soundmesh: 'tabStream', id: m.id, title: m.title }, location.origin); reply({ ok: true }); }
});
