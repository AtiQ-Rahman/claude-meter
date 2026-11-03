// The reading as sent to the Claude Meter GNOME extension's native host.
// Session and week go to its usage.json; the plan, per-model limits and extra usage
// go to its account.json, in the shape the GNOME extension's own parser produces.

const seconds = ms => (ms ? Math.floor(ms / 1000) : null);

export function gnomeMessage(usage) {
  const pick = key => {
    const w = usage.windows.find(x => x.key === key);
    return w ? { used_percentage: w.pct, resets_at: seconds(w.resetsAt) } : null;
  };
  return {
    five_hour: pick('five_hour'),
    seven_day: pick('seven_day'),
    model: 'claude.ai',
    plan: usage.plan || null,
    limits: usage.windows
      .filter(w => w.gnomeTitle)
      .map(w => ({ title: w.gnomeTitle, used_percentage: w.pct, resets_at: seconds(w.resetsAt) })),
    extra_usage: usage.extra || null,
  };
}
