// Runs on claude.ai:
// 1. Makes usage requests from the page when the background's direct request is blocked.
// 2. Counts messages you send (for the "messages left" estimate) and asks for a fresh reading.
// 3. Shows a small meter in the corner of the page.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'claude-meter:fetch') return false;
  fetch(`https://claude.ai${msg.path}`, { credentials: 'include', headers: { accept: 'application/json' } })
    .then(async res => sendResponse({ ok: res.ok, status: res.status, json: res.ok ? await res.json() : null }))
    .catch(e => sendResponse({ ok: false, status: 0, error: e.message }));
  return true;
});

function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Reply streaming takes a while; check after it has likely finished.
const AFTER_SEND_MS = 30 * 1000;
let refreshTimer = null;
let lastSend = 0;

function refreshSoon(delayMs) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => send({ type: 'claude-meter:refresh' }), delayMs);
}

function onSend() {
  // Enter and a send-button click can both fire for one message.
  if (Date.now() - lastSend < 1000) return;
  lastSend = Date.now();
  send({ type: 'claude-meter:sent' });
  refreshSoon(AFTER_SEND_MS);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing
      && e.target.closest?.('[contenteditable="true"], textarea')
      && e.target.textContent.trim() + (e.target.value || '').trim() !== '') {
    onSend();
  }
}, true);

document.addEventListener('click', e => {
  if (e.target.closest?.('button[aria-label*="send" i]')) onSend();
}, true);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSoon(1000);
});

// ---- On-page meter ----

const DEFAULTS = { pageMeter: true, warnPct: 80, critPct: 90 };
let host = null;

function level(pct, s) {
  if (pct >= s.critPct) return 'crit';
  if (pct >= s.warnPct) return 'warn';
  return 'ok';
}

function untilText(ts) {
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.id = 'usage-meter-for-claude';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .pill {
        position: fixed; right: 14px; bottom: 14px; z-index: 2147483000;
        display: flex; align-items: center; gap: 8px;
        padding: 5px 10px; border-radius: 999px;
        font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif;
        color: #3d3d3a; background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(0, 0, 0, 0.08); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
        cursor: default; user-select: none; opacity: 0.85; transition: opacity 0.15s;
      }
      .pill:hover { opacity: 1; }
      .key { font-weight: 500; opacity: 0.65; margin-right: 3px; }
      .sep { opacity: 0.35; }
      .ok { color: #2e7d32; } .warn { color: #a5650b; } .crit { color: #c62828; }
      .left { font-weight: 500; opacity: 0.75; }
      @media (prefers-color-scheme: dark) {
        .pill { color: #e8e6e3; background: rgba(38, 38, 36, 0.92); border-color: rgba(255, 255, 255, 0.1); }
        .ok { color: #8fd18f; } .warn { color: #f0c05a; } .crit { color: #ff6b6b; }
      }
    </style>
    <div class="pill" role="status" aria-live="polite"></div>`;
  document.documentElement.append(host);
  return host;
}

function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

async function renderMeter() {
  const { settings } = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  const { usage } = await chrome.storage.local.get('usage');
  const windows = (usage?.windows || []).filter(w => w.key === 'five_hour' || w.key === 'seven_day');

  if (!s.pageMeter || windows.length === 0) {
    if (host) host.style.display = 'none';
    return;
  }
  ensureHost().style.display = '';
  const pill = host.shadowRoot.querySelector('.pill');
  const parts = [];
  for (const w of windows) {
    const item = span('', '');
    item.append(span('key', w.key === 'five_hour' ? 'Session' : 'Week'), span(level(w.pct, s), `${w.pct}%`));
    parts.push(item);
  }
  const left = usage.messagesLeft?.five_hour;
  if (left != null) parts.push(span('left', `~${left} msgs left`));

  pill.replaceChildren();
  parts.forEach((p, i) => {
    if (i) pill.append(span('sep', '·'));
    pill.append(p);
  });
  pill.title = windows
    .map(w => `${w.label}: ${w.pct}%${w.resetsAt ? `, resets in ${untilText(w.resetsAt)}` : ''}`)
    .join('\n');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.usage) || (area === 'sync' && changes.settings)) renderMeter();
});
renderMeter();
