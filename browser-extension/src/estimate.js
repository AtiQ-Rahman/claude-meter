// "Messages left" estimate: how much one message moves each limit, learned from your own use.
//
// The content script counts messages you send (sendsTotal). Each time a limit goes up,
// the messages sent since the last rise are credited with that rise.

import { sameWindow } from './forecast.js';

const MAX_SAMPLES = 30;
const MIN_MESSAGES = 3;

export function updateCosts(costs, prevWindows, windows, sendsTotal) {
  const next = { ...costs };
  for (const w of windows) {
    const entry = costs[w.key] || { mark: sendsTotal, samples: [] };
    const prev = prevWindows?.find(p => p.key === w.key);
    if (!prev || !sameWindow(prev.resetsAt, w.resetsAt)) {
      next[w.key] = { mark: sendsTotal, samples: entry.samples };
      continue;
    }
    const rise = w.pct - prev.pct;
    const sent = sendsTotal - entry.mark;
    if (rise === 0) {
      next[w.key] = entry; // keep counting until the limit moves
    } else {
      // A rise with no messages came from elsewhere (another device, Claude Code): don't learn from it.
      const samples = rise > 0 && sent > 0
        ? [...entry.samples, { n: sent, d: rise }].slice(-MAX_SAMPLES)
        : entry.samples;
      next[w.key] = { mark: sendsTotal, samples };
    }
  }
  return next;
}

export function messagesLeft(entry, pct) {
  if (!entry) return null;
  const n = entry.samples.reduce((a, s) => a + s.n, 0);
  const d = entry.samples.reduce((a, s) => a + s.d, 0);
  if (n < MIN_MESSAGES || d <= 0) return null;
  return Math.max(0, Math.floor((100 - pct) / (d / n)));
}
