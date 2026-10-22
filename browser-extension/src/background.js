// Service worker: polls claude.ai usage, keeps the toolbar current and fires alerts.

import { getSettings } from './settings.js';
import { fetchUsage } from './usage.js';
import { recordSample, forecast } from './forecast.js';
import { decideAlerts } from './alerts.js';
import { updateCosts, messagesLeft } from './estimate.js';
import { inQuietHours } from './quiet.js';
import { ringIcon } from './icon.js';
import { formatDuration, formatClock, isWeekly, level } from './format.js';

const NAME = 'Usage Meter for Claude';
const NATIVE_HOST = 'io.github.atiq_rahman.claude_meter';
const MIN_GAP_MS = 15 * 1000;
const TIMELINE_STEP_MS = 15 * 60 * 1000;
const TIMELINE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const BADGE_COLORS = { ok: '#2e7d32', warn: '#b7791f', crit: '#d32f2f', error: '#6b7280' };
const STATIC_ICON = { 16: 'icons/16.png', 32: 'icons/32.png' };

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
    const error = { kind: e.kind || 'network', message: e.message, at: now, details: e.details || null };
    await chrome.storage.local.set({ error });
    await chrome.action.setIcon({ path: STATIC_ICON });
    await setBadge('!', BADGE_COLORS.error, error.kind === 'auth'
      ? `${NAME}: log in to claude.ai to see your usage`
      : `${NAME}: ${error.message}`);
    return;
  }

  const stored = await chrome.storage.local.get(['usage', 'history', 'alertState', 'costs', 'sendsTotal', 'timeline']);
  let history = stored.history || {};
  const forecasts = {};
  for (const w of usage.windows) {
    history = recordSample(history, w, now);
    forecasts[w.key] = forecast(history[w.key].samples, w, now);
  }
  const costs = updateCosts(stored.costs || {}, stored.usage?.windows, usage.windows, stored.sendsTotal || 0);
  const left = {};
  for (const w of usage.windows) left[w.key] = messagesLeft(costs[w.key], w.pct);
  const { events, state } = decideAlerts(stored.alertState || {}, usage.windows, forecasts, settings, now);

  usage.forecasts = forecasts;
  usage.messagesLeft = left;
  await chrome.storage.local.set({
    usage,
    history,
    costs,
    alertState: state,
    timeline: extendTimeline(stored.timeline || [], usage.windows, now),
    error: null,
  });

  await updateToolbar(usage, settings);
  scheduleResetChecks(usage.windows, now);
  if (settings.gnomeBridge) sendToGnome(usage);
  for (const event of events) await fire(event, settings, now);
}

// One point every 15 minutes for the history chart, kept for 7 days.
function extendTimeline(timeline, windows, now) {
  const last = timeline[timeline.length - 1];
  if (last && now - last.t < TIMELINE_STEP_MS) return timeline;
  const pct = key => windows.find(w => w.key === key)?.pct ?? null;
  return [...timeline.filter(p => now - p.t <= TIMELINE_KEEP_MS), { t: now, s: pct('five_hour'), w: pct('seven_day') }];
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  await chrome.action.setTitle({ title });
}

async function updateToolbar(usage, settings) {
  const ws = usage.windows;
  const shown = settings.badge === 'max' || settings.badge === 'none'
    ? ws.reduce((a, b) => (b.pct > a.pct ? b : a))
    : ws.find(w => w.key === settings.badge) || ws[0];
  const lv = level(shown.pct, settings);
  const title = [NAME, ...ws.map(w => `${w.label}: ${w.pct}%`)].join('\n');
  const text = settings.badge === 'none' ? '' : shown.pct >= 100 ? '100' : `${shown.pct}%`;
  await setBadge(text, BADGE_COLORS[lv], title);
  await chrome.action.setIcon(settings.iconRing ? { imageData: ringIcon(shown.pct, lv) } : { path: STATIC_ICON });
}

// Check again right after each limit resets, so the reset notice is on time.
function scheduleResetChecks(windows, now) {
  for (const w of windows) {
    if (w.resetsAt && w.resetsAt > now) chrome.alarms.create(`reset:${w.key}`, { when: w.resetsAt + 15 * 1000 });
  }
}

// Optional: hand the reading to the GNOME extension through a small native host.
function sendToGnome(usage) {
  if (!chrome.runtime.sendNativeMessage) return; // optional permission not granted
  const pick = key => {
    const w = usage.windows.find(x => x.key === key);
    return w ? { used_percentage: w.pct, resets_at: w.resetsAt ? Math.floor(w.resetsAt / 1000) : null } : null;
  };
  chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    five_hour: pick('five_hour'),
    seven_day: pick('seven_day'),
    model: 'claude.ai',
  }).catch(e => console.warn(`${NAME}: GNOME bridge not reachable`, e.message));
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

  const withSound = settings.sound && !inQuietHours(settings, new Date(now));
  // Clear first so an updated alert pops up again instead of changing silently.
  await chrome.notifications.clear(id);
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/128.png'),
    title,
    message,
    priority: 2,
    requireInteraction: sticky,
    silent: true,
  });
  if (withSound) await playSound(sound, settings.volume);
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
    console.warn(`${NAME}: could not play sound`, e);
  }
}

async function countSend() {
  const { sendsTotal = 0 } = await chrome.storage.local.get('sendsTotal');
  await chrome.storage.local.set({ sendsTotal: sendsTotal + 1 });
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
  else if (alarm.name.startsWith('reset:')) refresh({ force: true });
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
  switch (msg?.type) {
    case 'claude-meter:refresh':
      refresh({ force: Boolean(msg.force) }).then(() => sendResponse({ ok: true }));
      return true;
    case 'claude-meter:sent':
      countSend().then(() => sendResponse({ ok: true }));
      return true;
    case 'claude-meter:test-sound':
      playSound(msg.name, msg.volume).then(() => sendResponse({ ok: true }));
      return true;
    case 'claude-meter:test-gnome':
      if (!chrome.runtime.sendNativeMessage) {
        sendResponse({ ok: false, error: 'Permission not granted' });
        return false;
      }
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { ping: true })
        .then(res => sendResponse({ ok: Boolean(res?.ok) }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    default:
      return false;
  }
});
