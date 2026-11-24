importScripts('send.js');
// 快捷键 Alt+Shift+S：把当前分页的声音送到 SoundMesh（工具栏图标上会显示 ✓ 或 ✗）
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'send-audio') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const badge = (text, color) => {
    chrome.action.setBadgeBackgroundColor({ color, tabId: tab.id });
    chrome.action.setBadgeText({ text, tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 4000);
  };
  try { await sendTabAudio(tab); badge('✓', '#2f9e44'); }
  catch (e) { badge('✗', '#e03131'); console.warn(e); }
});
