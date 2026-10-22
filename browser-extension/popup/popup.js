import { getSettings } from '../src/settings.js';
import { formatDuration, formatClock, isWeekly, level } from '../src/format.js';

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function forecastText(f, w, now) {
  if (!f) return { text: 'Pace forecast after about 10 minutes of use', cls: 'muted' };
  if (f.hitAt) {
    const when = formatClock(f.hitAt, isWeekly(w.key));
    return { text: `At this pace: 100% at ${when} (in ${formatDuration(f.hitAt - now)})`, cls: 'warn' };
  }
  if (f.ratePerHour > 0) return { text: `At this pace you stay under the limit (+${f.ratePerHour.toFixed(1)}%/h)`, cls: 'muted' };
  return { text: 'Not climbing right now', cls: 'muted' };
}

function renderWindow(w, forecast, left, settings, now) {
  const lv = level(w.pct, settings);
  const box = el('div', 'window');

  const head = el('div', 'row');
  head.append(el('span', 'label', w.label), el('span', `pct ${lv}`, `${w.pct}%`));

  const track = el('div', 'track');
  const fill = el('div', `fill ${lv}`);
  fill.style.width = `${Math.min(100, w.pct)}%`;
  track.append(fill);

  box.append(head, track);
  if (w.resetsAt) {
    box.append(el('div', 'muted small',
      `Resets in ${formatDuration(w.resetsAt - now)} · ${formatClock(w.resetsAt, isWeekly(w.key))}`));
  }
  if (left != null) box.append(el('div', 'small', `About ${left} messages left at your usual size`));
  const f = forecastText(forecast, w, now);
  box.append(el('div', `forecast small ${f.cls}`, f.text));
  return box;
}

async function render() {
  const settings = await getSettings();
  const { usage, error } = await chrome.storage.local.get(['usage', 'error']);
  const now = Date.now();

  const list = $('windows');
  list.replaceChildren();
  if (usage) {
    for (const w of usage.windows) list.append(renderWindow(w, usage.forecasts?.[w.key], usage.messagesLeft?.[w.key], settings, now));
    $('org').textContent = usage.org?.name || '';
    $('updated').textContent = `Updated ${formatDuration(now - usage.fetchedAt)} ago`;
  } else {
    $('updated').textContent = error ? '' : 'Loading…';
  }

  $('error').hidden = !error;
  if (error) {
    const auth = error.kind === 'auth';
    $('error-text').textContent = auth
      ? 'Log in to claude.ai to see your usage.'
      : `Could not read usage: ${error.message}. See Settings > Diagnostics.`;
    $('login').hidden = !auth;
  }
}

async function refresh() {
  $('refresh').classList.add('spinning');
  try {
    await chrome.runtime.sendMessage({ type: 'claude-meter:refresh', force: true });
  } finally {
    $('refresh').classList.remove('spinning');
    render();
  }
}

$('refresh').addEventListener('click', refresh);
$('login').addEventListener('click', () => chrome.tabs.create({ url: 'https://claude.ai/login' }));
$('open-usage').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
});
$('open-options').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener(render);

render();
refresh();
