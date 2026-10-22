// Pace forecast: from recent samples, when will this window reach 100%?

const HOUR = 60 * 60 * 1000;
const FIT_WINDOW = HOUR;          // fit the trend over the last hour
const MIN_SPAN = 10 * 60 * 1000;  // need at least 10 minutes of data
const KEEP = 6 * HOUR;
const MAX_SAMPLES = 300;

// resets_at identifies a window; allow some drift between reports.
export function sameWindow(a, b) {
  if (a == null || b == null) return a == b;
  return Math.abs(a - b) < HOUR;
}

export function recordSample(history, w, now) {
  const prev = history[w.key];
  const kept = prev && sameWindow(prev.resetsAt, w.resetsAt)
    ? prev.samples.filter(s => now - s.t <= KEEP)
    : [];
  kept.push({ t: now, pct: w.pct });
  return { ...history, [w.key]: { resetsAt: w.resetsAt, samples: kept.slice(-MAX_SAMPLES) } };
}

// Returns null when there is not enough data, otherwise
// { ratePerHour, hitAt } where hitAt is null if the limit won't be hit before reset.
export function forecast(samples, w, now) {
  const recent = samples.filter(s => now - s.t <= FIT_WINDOW);
  if (recent.length < 3 || recent[recent.length - 1].t - recent[0].t < MIN_SPAN) return null;

  // Least-squares slope, in percent per millisecond.
  const n = recent.length;
  const mt = recent.reduce((a, s) => a + s.t, 0) / n;
  const mp = recent.reduce((a, s) => a + s.pct, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of recent) {
    num += (s.t - mt) * (s.pct - mp);
    den += (s.t - mt) ** 2;
  }
  const slope = den ? num / den : 0;
  if (slope <= 0) return { ratePerHour: 0, hitAt: null };

  const hitAt = w.pct >= 100 ? now : now + (100 - w.pct) / slope;
  return {
    ratePerHour: slope * HOUR,
    hitAt: w.resetsAt && hitAt >= w.resetsAt ? null : hitAt,
  };
}
