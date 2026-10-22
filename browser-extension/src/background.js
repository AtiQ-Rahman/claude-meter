// Service worker: polls claude.ai usage, keeps the badge current and fires alerts.

import { getSettings } from './settings.js';
import { fetchUsage } from './usage.js';
import { recordSample, forecast } from './forecast.js';
import { decideAlerts } from './alerts.js';
import { formatDuration, formatClock, isWeekly, level } from './format.js';

const MIN_GAP_MS = 15 * 1000;
const BADGE_COLORS = { ok: '#2e7d32', warn: '#b7791f', crit: '#d32f2f', error: '#6b7280' };

let running = null;
let lastRun = 0;

function refresh({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() - lastRun < MIN_GAP_MS) return Promise.resolve();
  running = doRefresh().finally(() => {
    running = null;
    lastRun = Date.now();
  });
  return running;
}

async function doRefresh() {
  const settings = await getSettings();
  const now = Date.now();

  let usage;
  try {
    usage = await fetchUsage(settings);
  } catch (e) {
    const error = { kind: e.kind || 'network', message: e.message, at: now };
    await chrome.storage.local.set({ error });
    await setBadge('!', BADGE_COLORS.error, error.kind === 'auth'
      ? 'Claude Meter: log in to claude.ai to see your usage'
      : `Claude Meter: ${error.message}`);
    return;
  }

  let { history = {}, alertState = {} } = await chrome.storage.local.get(['history', 'alertState']);
  const forecasts = {};
  for (const w of usage.windows) {
    history = recordSample(history, w, now);
    forecasts[w.key] = forecast(history[w.key].samples, w, now);
  }
  const { events, state } = decideAlerts(alertState, usage.windows, forecasts, settings, now);
  usage.forecasts = forecasts;

  await chrome.storage.local.set({ usage, history, alertState: state, error: null });
  await updateBadge(usage, settings);
  for (const event of events) await fire(event, settings, now);
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title });
}

async function updateBadge(usage, settings) {
  const ws = usage.windows;
  const shown = settings.badge === 'max'
    ? ws.reduce((a, b) => (b.pct > a.pct ? b : a))
    : ws.find(w => w.key === settings.badge) || ws[0];
  const text = shown.pct >= 100 ? '100' : `${shown.pct}%`;
  const title = ['Claude Meter', ...ws.map(w => `${w.label}: ${w.pct}%`)].join('\n');
  await setBadge(text, BADGE_COLORS[level(shown.pct, settings)], title);
}

function resetLine(w, now) {
  if (!w.resetsAt) return '';
  return `Resets in ${formatDuration(w.resetsAt - now)} (${formatClock(w.resetsAt, isWeekly(w.key))})`;
}

async function fire(event, settings, now) {
  const w = event.window;
  let id = `claude-meter-${w.key}`;
  let title;
  let message;
  let sound;
  let sticky = false;

  switch (event.kind) {
    case 'warn':
    case 'crit':
      title = `${w.label} usage at ${w.pct}%`;
      message = resetLine(w, now);
      sound = event.kind;
      sticky = event.kind === 'crit';
      break;
    case 'forecast':
      id += '-forecast';
      title = `${w.label} limit in about ${formatDuration(event.hitAt - now)}`;
      message = `At your current pace you will reach 100% at ${formatClock(event.hitAt, isWeekly(w.key))}, `
        + `before it resets. Now at ${w.pct}%.`;
      sound = 'warn';
      break;
    case 'reset':
      id += '-reset';
      title = `${w.label} limit has reset`;
      message = `You are back to ${w.pct}%.`;
      sound = 'reset';
      break;
    default:
      return;
  }

  // Clear first so an updated alert pops up again instead of changing silently.
  await chrome.notifications.clear(id);
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title,
    message,
    priority: 2,
    requireInteraction: sticky,
    silent: settings.sound,
  });
  if (settings.sound) await playSound(sound, settings.volume);
}

async function playSound(name, volume) {
  try {
    const exists = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play usage alert sounds',
      });
    }
  } catch (e) {
    // Another call created it first.
  }
  try {
    await chrome.runtime.sendMessage({ type: 'claude-meter:play', name, volume });
  } catch (e) {
    console.warn('Claude Meter: could not play sound', e);
  }
}

async function schedule() {
  const { pollMinutes } = await getSettings();
  await chrome.alarms.create('poll', { periodInMinutes: Math.max(1, Number(pollMinutes) || 2) });
}

chrome.runtime.onInstalled.addListener(() => {
  schedule();
  refresh({ force: true });
});

chrome.runtime.onStartup.addListener(() => {
  schedule();
  refresh({ force: true });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'poll') refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    schedule();
    refresh({ force: true });
  }
});

chrome.notifications.onClicked.addListener(id => {
  chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'claude-meter:refresh') {
    refresh({ force: Boolean(msg.force) }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'claude-meter:test-sound') {
    playSound(msg.name, msg.volume).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
