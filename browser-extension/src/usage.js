// Reads the usage limits that claude.ai shows on Settings > Usage.
// This is claude.ai's own (undocumented) web API, so parsing is defensive.

const BASE = 'https://claude.ai';
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
const LABELS = {
  five_hour: 'Session',
  seven_day: 'Week',
  seven_day_opus: 'Week (Opus)',
  seven_day_sonnet: 'Week (Sonnet)',
};

export class UsageError extends Error {
  // kind: 'auth' (not logged in), 'network', or 'format' (unexpected response)
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function fetchDirect(path) {
  let res;
  try {
    res = await fetch(BASE + path, { credentials: 'include', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new UsageError('network', e.message);
  }
  if (res.status === 401 || res.status === 403) throw new UsageError('auth', `HTTP ${res.status}`);
  if (!res.ok) throw new UsageError('network', `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new UsageError('format', 'Response was not JSON');
  }
}

// Same request, made from inside an open claude.ai tab. Used when the direct
// request is blocked (for example by a bot check that only the page passes).
async function fetchViaTab(path) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'claude-meter:fetch', path });
      if (!res) continue;
      if (res.status === 401 || res.status === 403) throw new UsageError('auth', `HTTP ${res.status}`);
      if (!res.ok) throw new UsageError('network', res.error || `HTTP ${res.status}`);
      return res.json;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      // Tab without our content script (opened before install); try the next one.
    }
  }
  return null;
}

async function getJson(path) {
  try {
    return await fetchDirect(path);
  } catch (e) {
    if (e.kind === 'format') throw e;
    const json = await fetchViaTab(path);
    if (json == null) throw e;
    return json;
  }
}

// Orgs to try, best first: the chosen one, then the Pro/Max subscription, then chat orgs.
export function orderOrgs(orgs, preferredId) {
  if (!Array.isArray(orgs)) return [];
  const caps = o => o.capabilities || [];
  const score = o => (o.uuid === preferredId ? 0
    : caps(o).some(c => /claude_(max|pro)/.test(c)) ? 1
      : caps(o).includes('chat') ? 2 : 3);
  return orgs.filter(o => o && o.uuid).sort((a, b) => score(a) - score(b));
}

function prettify(key) {
  return key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseUsage(json) {
  if (!json || typeof json !== 'object') throw new UsageError('format', 'Empty usage response');
  const windows = [];
  for (const [key, value] of Object.entries(json)) {
    if (!value || typeof value !== 'object') continue;
    const pct = toNumber(value.utilization ?? value.used_percentage ?? value.percent_used);
    if (pct == null) continue;
    const resetsAt = value.resets_at ? Date.parse(value.resets_at) : NaN;
    windows.push({
      key,
      label: LABELS[key] || prettify(key),
      pct: Math.round(pct),
      resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    });
  }
  if (windows.length === 0) throw new UsageError('format', 'No usage windows found in the response');
  const rank = k => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  return windows.sort((a, b) => rank(a.key) - rank(b.key));
}

export async function fetchUsage(settings) {
  const orgs = await getJson('/api/organizations');
  const candidates = orderOrgs(orgs, settings.orgId);
  if (candidates.length === 0) throw new UsageError('auth', 'No organization found. Are you logged in to claude.ai?');

  // Not every org has usage limits (for example API-only orgs), so try each until one does.
  const tried = [];
  let lastError = null;
  for (const org of candidates) {
    let raw;
    try {
      raw = await getJson(`/api/organizations/${org.uuid}/usage`);
      return {
        org: { uuid: org.uuid, name: org.name || '' },
        orgs: candidates.map(o => ({ uuid: o.uuid, name: o.name || o.uuid })),
        windows: parseUsage(raw),
        raw,
        fetchedAt: Date.now(),
      };
    } catch (e) {
      tried.push({ org: org.name || org.uuid, capabilities: org.capabilities || [], error: e.message, response: raw ?? null });
      lastError = e;
    }
  }
  lastError.details = tried;
  throw lastError;
}
