const $ = (id) => document.getElementById(id);
let cfg = { enabled: true, trim: 0 };
function render(r) {
  if (r.smCfg) cfg = { ...cfg, ...r.smCfg };
  $('en').checked = cfg.enabled; $('trim').value = cfg.trim; $('tv').textContent = (cfg.trim > 0 ? '+' : '') + cfg.trim + ' ms';
  const d = r.smDelay, y = r.smYt, now = Date.now();
  let t;
  if (!cfg.enabled) t = '已关闭';
  else if (!d || now - d.t > 4000) t = '❌ 没收到 SoundMesh 的数据<br>请在这台电脑的 Chrome 打开 SoundMesh 主机页面';
  else if (!d.live) t = '⏸ SoundMesh 还没开始共享声音';
  else t = `✅ SoundMesh 已连接：画面延后 <b>${d.ms + cfg.trim} ms</b>`;
  if (cfg.enabled && y && now - y.t < 3000) t += y.broken ? '<br>⚠️ 这个视频受保护，无法延后' : y.on ? '<br>▶ 视频画面正在延后' : '';
  $('st').innerHTML = t;
}
const refresh = () => chrome.storage.local.get(['smCfg', 'smDelay', 'smYt'], render);
const save = () => chrome.storage.local.set({ smCfg: cfg }, refresh);
$('en').onchange = (e) => { cfg.enabled = e.target.checked; save(); };
$('trim').oninput = (e) => { cfg.trim = Number(e.target.value); $('tv').textContent = (cfg.trim > 0 ? '+' : '') + cfg.trim + ' ms'; save(); };
refresh(); setInterval(refresh, 1000);
$('send').onclick = async () => {
  const msg = (t) => ($('sendMsg').textContent = t);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await sendTabAudio(tab);
    msg('✅ 已送出，几秒内手机/平板就会出声（下次可以直接按 Alt+Shift+S）');
  } catch (e) {
    msg('❌ ' + (e.message || e) + '（如果刚更新扩展，请先刷新 SoundMesh 页面）');
  }
};
