// Runs on claude.ai. Two jobs:
// 1. Make usage requests from the page when the background's direct request is blocked.
// 2. Ask for a fresh reading shortly after you send a message, since that is when usage moves.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'claude-meter:fetch') return false;
  fetch(`https://claude.ai${msg.path}`, { credentials: 'include', headers: { accept: 'application/json' } })
    .then(async res => sendResponse({ ok: res.ok, status: res.status, json: res.ok ? await res.json() : null }))
    .catch(e => sendResponse({ ok: false, status: 0, error: e.message }));
  return true;
});

let timer = null;
function refreshSoon(delayMs) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'claude-meter:refresh' }).catch(() => {});
  }, delayMs);
}

// Reply streaming takes a while; check after it has likely finished.
const AFTER_SEND_MS = 30 * 1000;

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest?.('[contenteditable="true"], textarea')) {
    refreshSoon(AFTER_SEND_MS);
  }
}, true);

document.addEventListener('click', e => {
  if (e.target.closest?.('button[aria-label*="send" i]')) refreshSoon(AFTER_SEND_MS);
}, true);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSoon(1000);
});
