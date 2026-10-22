// Shared formatting for the background worker, popup and options page.

export function formatDuration(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatClock(ts, withDay) {
  const opts = { hour: 'numeric', minute: '2-digit' };
  if (withDay) opts.weekday = 'short';
  return new Date(ts).toLocaleString(undefined, opts);
}

export function isWeekly(key) {
  return key.startsWith('seven_day');
}

export function level(pct, settings) {
  if (pct >= settings.critPct) return 'crit';
  if (pct >= settings.warnPct) return 'warn';
  return 'ok';
}
