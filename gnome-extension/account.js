/* Parses a Claude usage response into what the menu shows: the usage API behind
 * Claude Code's /usage answers in this shape, and so does claude.ai. Neither is
 * documented, so parsing is defensive. Kept apart from extension.js so that
 * dev/test-account.js can run it outside GNOME Shell.
 *
 * Written for GNOME 45+ (ES modules). dev/build-legacy.sh converts it for GNOME 42-44,
 * so keep imports to the one-line forms that script knows and export only functions. */

import GLib from 'gi://GLib';

export function prettify(key) {
    return key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// ISO 8601 time -> epoch seconds.
function epoch(iso) {
    const dt = typeof iso === 'string' ? GLib.DateTime.new_from_iso8601(iso, null) : null;
    return dt ? dt.to_unix() : null;
}

function number(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function text(v) {
    return typeof v === 'string' && v !== '' ? v : null;
}

// "default_claude_max_5x" -> "Max (5x)", otherwise the subscription type, e.g. "Pro".
export function planName(oauth) {
    const max = /claude_max_(\d+)x/.exec(oauth.rateLimitTier || '');
    if (max) return `Max (${max[1]}x)`;
    const type = text(oauth.subscriptionType);
    return type ? prettify(type) : null;
}

// {amount_minor: 1250, currency: 'USD', exponent: 2} -> "$12.50"
function money(m) {
    if (!m || number(m.amount_minor) == null) return null;
    const digits = Number.isInteger(m.exponent) && m.exponent >= 0 && m.exponent <= 6 ? m.exponent : 2;
    const amount = (m.amount_minor / 10 ** digits).toFixed(digits);
    return !m.currency || m.currency === 'USD' ? `$${amount}` : `${amount} ${m.currency}`;
}

function apiWindow(w) {
    return w && number(w.utilization) != null
        ? { used_percentage: w.utilization, resets_at: epoch(w.resets_at) }
        : null;
}

// The model or product a limit applies to, e.g. "Fable".
function scopeName(scope) {
    for (const part of [scope && scope.model, scope && scope.surface]) {
        const name = text(part && typeof part === 'object' ? part.display_name : part);
        if (name) return name;
    }
    return null;
}

// "Week · Fable" for the weekly limit on one model.
function limitTitle(limit) {
    const what = scopeName(limit.scope);
    const base = limit.group === 'weekly' ? 'Week' : prettify(String(limit.kind));
    return what ? `${base} · ${what}` : base;
}

function extraUsage(json) {
    const s = json.spend;
    if (s && typeof s === 'object') {
        return {
            enabled: !!s.enabled,
            used_percentage: number(s.percent),
            used: money(s.used),
            limit: money(s.limit),
            reason: text(s.disabled_reason),
        };
    }
    const e = json.extra_usage;
    if (e && typeof e === 'object') {
        return {
            enabled: !!e.is_enabled,
            used_percentage: number(e.utilization),
            used: null,
            limit: null,
            reason: text(e.disabled_reason),
        };
    }
    return null;
}

// Turns a usage response into usage.json's shape, plus the plan, the limits beyond
// session and week (such as one model's weekly limit) and extra usage. Returns null for
// a response with no session, week or other limit, which has nothing to show.
export function parseAccount(json, oauth, now) {
    const list = Array.isArray(json.limits) ? json.limits.filter(l => l && number(l.percent) != null) : null;
    let limits;
    if (list) {
        limits = list
            .filter(l => l.kind !== 'session' && l.kind !== 'weekly_all')
            .map(l => ({ title: limitTitle(l), used_percentage: l.percent, resets_at: epoch(l.resets_at) }));
    } else {
        // Older responses had one key per model instead.
        limits = [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]
            .filter(([key]) => apiWindow(json[key]))
            .map(([key, name]) => Object.assign({ title: `Week · ${name}` }, apiWindow(json[key])));
    }
    // Session and week are in the list too, for a response without their own keys.
    const listed = kind => {
        const l = list && list.find(x => x.kind === kind);
        return l ? { used_percentage: l.percent, resets_at: epoch(l.resets_at) } : null;
    };
    const fiveHour = apiWindow(json.five_hour) || listed('session');
    const sevenDay = apiWindow(json.seven_day) || listed('weekly_all');
    if (!fiveHour && !sevenDay && limits.length === 0) return null;
    return {
        five_hour: fiveHour,
        seven_day: sevenDay,
        plan: planName(oauth),
        limits,
        extra_usage: extraUsage(json),
        updated_at: now,
    };
}
