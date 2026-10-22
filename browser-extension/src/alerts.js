// Decides which alerts to fire. Pure: takes the saved state and returns events plus new state.

import { sameWindow } from './forecast.js';

// Alert steps: warnPct, critPct, then every percent from everyPctFrom. 0 means none yet.
export function alertStep(pct, s) {
  if (pct >= s.everyPctFrom) return Math.min(pct, 100);
  if (pct >= s.critPct) return s.critPct;
  if (pct >= s.warnPct) return s.warnPct;
  return 0;
}

// Event kinds: 'warn', 'crit', 'forecast' (on pace to hit 100% soon), 'reset' (limit refilled).
export function decideAlerts(state, windows, forecasts, s, now) {
  const next = { ...state };
  const events = [];
  for (const w of windows) {
    const prev = state[w.key];
    const same = prev && sameWindow(prev.resetsAt, w.resetsAt);

    if (prev && !same && prev.step > 0 && s.notifyOnReset) events.push({ kind: 'reset', window: w });

    const last = same ? prev.step : 0;
    const step = alertStep(w.pct, s);
    if (step > last) events.push({ kind: step >= s.critPct ? 'crit' : 'warn', window: w });

    let forecastSent = same ? Boolean(prev.forecastSent) : false;
    const f = forecasts[w.key];
    if (s.forecastAlert && !forecastSent && f && f.hitAt && w.pct < s.critPct
        && f.hitAt - now <= s.forecastMinutes * 60 * 1000) {
      events.push({ kind: 'forecast', window: w, hitAt: f.hitAt });
      forecastSent = true;
    }

    next[w.key] = { resetsAt: w.resetsAt, step: Math.max(step, last), forecastSent };
  }
  return { events, state: next };
}
