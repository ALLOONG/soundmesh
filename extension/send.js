// 把 tab 这个分页的声音交给 SoundMesh 主机分页（弹窗按钮和快捷键共用）
async function sendTabAudio(tab) {
  const sms = await chrome.tabs.query({ url: ['https://alloong.github.io/soundmesh/*', 'http://localhost/*', 'http://127.0.0.1/*'] });
  const sm = sms.find((t) => t.id !== tab.id);
  if (!sm) throw new Error('找不到 SoundMesh 主机分页，请先在这个 Chrome 里打开它');
  if (tab.url?.includes('alloong.github.io/soundmesh')) throw new Error('请在 YouTube 那个分页使用');
  const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id, consumerTabId: sm.id });
  await chrome.tabs.sendMessage(sm.id, { type: 'tabStream', id, title: tab.title });
}
