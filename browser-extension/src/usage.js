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
// Older responses had one key per model-specific weekly limit.
const MODELS = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet' };

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

export function prettify(key) {
  return key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function toTime(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}

function text(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

// The model or product a limit applies to, e.g. "Fable".
function scopeName(scope) {
  for (const part of [scope?.model, scope?.surface]) {
    const name = text(part && typeof part === 'object' ? part.display_name : part);
    if (name) return name;
  }
  return null;
}

// {amount_minor: 1250, currency: 'USD', exponent: 2} -> "$12.50"
function money(m) {
  if (!m || typeof m.amount_minor !== 'number' || !Number.isFinite(m.amount_minor)) return null;
  const digits = Number.isInteger(m.exponent) && m.exponent >= 0 && m.exponent <= 6 ? m.exponent : 2;
  const amount = (m.amount_minor / 10 ** digits).toFixed(digits);
  return !m.currency || m.currency === 'USD' ? `$${amount}` : `${amount} ${m.currency}`;
}

// Plan from the organization: "default_claude_max_5x" -> "Max (5x)", else Max or Pro.
export function planName(org) {
  const max = /claude_max_(\d+)x/.exec(org?.rate_limit_tier || '');
  if (max) return `Max (${max[1]}x)`;
  const caps = Array.isArray(org?.capabilities) ? org.capabilities : [];
  if (caps.includes('claude_max')) return 'Max';
  if (caps.includes('claude_pro')) return 'Pro';
  return null;
}

// Extra usage (paid usage beyond the plan): { enabled, used_percentage, used, limit, reason }
// with used and limit as money text, or null when the response has none.
export function parseExtraUsage(json) {
  const s = json?.spend;
  if (s && typeof s === 'object') {
    return {
      enabled: Boolean(s.enabled),
      used_percentage: toNumber(s.percent),
      used: money(s.used),
      limit: money(s.limit),
      reason: text(s.disabled_reason),
    };
  }
  const e = json?.extra_usage;
  if (e && typeof e === 'object') {
    return {
      enabled: Boolean(e.is_enabled),
      used_percentage: toNumber(e.utilization),
      used: null,
      limit: null,
      reason: text(e.disabled_reason),
    };
  }
  return null;
}

// Windows have { key, label, pct, resetsAt }. A limit on one model or product also has
// gnomeTitle, its name in the GNOME menu, e.g. "Week · Fable".
export function parseUsage(json) {
  if (!json || typeof json !== 'object') throw new UsageError('format', 'Empty usage response');
  const windows = [];
  const add = w => {
    if (!windows.some(x => x.key === w.key)) windows.push(w);
  };
  const limits = Array.isArray(json.limits) ? json.limits : [];
  // Newer responses list the limits on one model or product here. They come first so
  // that they win over a top-level key for the same limit.
  for (const l of limits) {
    const pct = toNumber(l?.percent);
    if (pct == null || l.kind === 'session' || l.kind === 'weekly_all') continue;
    const scope = scopeName(l.scope);
    const weekly = l.group === 'weekly';
    const base = weekly ? 'Week' : prettify(String(l.kind));
    const slug = scope ? `_${scope.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}` : '';
    add({
      key: `${weekly ? 'seven_day' : String(l.kind)}${slug}`,
      label: scope ? `${base} (${scope})` : base,
      pct: Math.round(pct),
      resetsAt: toTime(l.resets_at),
      gnomeTitle: scope ? `${base} · ${scope}` : base,
    });
  }
  for (const [key, value] of Object.entries(json)) {
    // Extra usage is added below, from the fuller spend details when there are any.
    if (key === 'extra_usage' || !value || typeof value !== 'object') continue;
    const pct = toNumber(value.utilization ?? value.used_percentage ?? value.percent_used);
    if (pct == null) continue;
    const model = MODELS[key];
    add({
      key,
      label: LABELS[key] || prettify(key),
      pct: Math.round(pct),
      resetsAt: toTime(value.resets_at),
      ...(model ? { gnomeTitle: `Week · ${model}` } : {}),
    });
  }
  // Session and week are in the list too, for a response without their own keys.
  for (const l of limits) {
    const key = { session: 'five_hour', weekly_all: 'seven_day' }[l?.kind];
    const pct = toNumber(l?.percent);
    if (key && pct != null) add({ key, label: LABELS[key], pct: Math.round(pct), resetsAt: toTime(l.resets_at) });
  }
  const extra = parseExtraUsage(json);
  if (extra?.enabled && extra.used_percentage != null) {
    add({ key: 'extra_usage', label: 'Extra usage', pct: Math.round(extra.used_percentage), resetsAt: null });
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
        plan: planName(org),
        orgs: candidates.map(o => ({ uuid: o.uuid, name: o.name || o.uuid })),
        windows: parseUsage(raw),
        extra: parseExtraUsage(raw),
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
