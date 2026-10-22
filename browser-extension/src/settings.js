// User settings, stored in chrome.storage.sync so they follow the browser profile.

export const DEFAULTS = {
  warnPct: 80,          // first alert, badge turns yellow
  critPct: 90,          // second alert, badge turns red, notification stays
  everyPctFrom: 95,     // from here, alert on every new percent
  sound: true,
  volume: 0.8,
  notifyOnReset: true,  // tell me when a limit I was warned about resets
  forecastAlert: true,  // warn when the current pace hits 100% before reset
  forecastMinutes: 30,  // ...and that will happen within this many minutes
  quietHours: false,    // no sound between quietStart and quietEnd (notifications still show)
  quietStart: '22:00',
  quietEnd: '08:00',
  badge: 'max',         // 'max' | 'five_hour' | 'seven_day' | 'none'
  iconRing: true,       // toolbar icon is a live ring of the badge value
  pageMeter: true,      // small meter in the corner of claude.ai
  pollMinutes: 2,
  orgId: '',            // empty: pick the subscription org automatically
  gnomeBridge: false,   // also send readings to the Claude Meter GNOME extension
};

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ settings });
  return settings;
}
