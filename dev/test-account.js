// Unit tests for gnome-extension/account.js, outside GNOME Shell: gjs -m dev/test-account.js
// The real response in fixtures/usage-response.json must parse to fixtures/usage-parsed.json,
// which the browser extension's test and the native host test check against too.

import GLib from 'gi://GLib';
import System from 'system';
import {parseAccount, planName} from '../gnome-extension/account.js';

const FIXTURES = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'fixtures']);
const readFixture = name => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${FIXTURES}/${name}`)[1]));
const MAX_5X = { rateLimitTier: 'default_claude_max_5x', subscriptionType: 'team' };
const RESET = '2026-11-04T15:00:00+00:00';
const RESET_EPOCH = 1793804400;
// Checks of the other parts add a session: a reading without any limit is rejected.
const SESSION = { utilization: 20, resets_at: RESET };

// JSON with sorted keys, so key order doesn't matter.
function canonical(v) {
    return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
        : x));
}

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
    checks++;
    if (canonical(actual) === canonical(expected)) return;
    failures++;
    printerr(`FAIL ${name}\n  expected ${canonical(expected)}\n  actual   ${canonical(actual)}`);
}

check('real response', parseAccount(readFixture('usage-response.json'), MAX_5X, 1000),
    Object.assign(readFixture('usage-parsed.json'), { updated_at: 1000 }));

const usd = amount_minor => ({ amount_minor, currency: 'USD', exponent: 2 });
check('extra usage on', parseAccount({ five_hour: SESSION, spend: { enabled: true, percent: 25, used: usd(1250), limit: usd(5000) } }, {}, 0).extra_usage,
    { enabled: true, used_percentage: 25, used: '$12.50', limit: '$50.00', reason: null });
check('other currencies', parseAccount({ five_hour: SESSION, spend: { enabled: true, percent: 1,
    used: { amount_minor: 1250, currency: 'EUR', exponent: 2 }, limit: { amount_minor: 7, currency: 'JPY', exponent: 0 } } }, {}, 0).extra_usage,
    { enabled: true, used_percentage: 1, used: '12.50 EUR', limit: '7 JPY', reason: null });
check('bad exponent', parseAccount({ five_hour: SESSION, spend: { used: { amount_minor: 5, exponent: -1 } } }, {}, 0).extra_usage.used, '$0.05');
check('older extra usage', parseAccount({ five_hour: SESSION, extra_usage: { is_enabled: true, utilization: 10 } }, {}, 0).extra_usage,
    { enabled: true, used_percentage: 10, used: null, limit: null, reason: null });

check('older per-model keys', parseAccount({ seven_day_opus: { utilization: 40, resets_at: RESET }, seven_day_sonnet: null }, {}, 0).limits,
    [{ title: 'Week · Opus', used_percentage: 40, resets_at: RESET_EPOCH }]);
check('limit scopes', parseAccount({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: RESET, scope: { model: null, surface: { display_name: 'Claude Code' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 6, scope: { surface: 'cowork' } },
    { kind: 'monthly_scoped', group: 'monthly', percent: 7, scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: '8' },
    { kind: 'session', group: 'session', percent: 9 },
    null,
] }, {}, 0).limits, [
    { title: 'Week · Claude Code', used_percentage: 5, resets_at: RESET_EPOCH },
    { title: 'Week · cowork', used_percentage: 6, resets_at: null },
    { title: 'Monthly scoped', used_percentage: 7, resets_at: null },
]);

check('session and week from the list', parseAccount({ limits: [
    { kind: 'session', group: 'session', percent: 9, resets_at: RESET },
    { kind: 'weekly_all', group: 'weekly', percent: 17 },
] }, {}, 0), { five_hour: { used_percentage: 9, resets_at: RESET_EPOCH }, seven_day: { used_percentage: 17, resets_at: null },
    plan: null, limits: [], extra_usage: null, updated_at: 0 });
check('own keys win over the list', parseAccount({ five_hour: { utilization: 5 }, limits: [{ kind: 'session', percent: 6 }] }, {}, 0).five_hour,
    { used_percentage: 5, resets_at: null });
check('nothing to show', [parseAccount({}, MAX_5X, 0), parseAccount({ limits: [], spend: { enabled: true, percent: 3 } }, MAX_5X, 0),
    parseAccount({ five_hour: null, limits: [{ kind: 'session', percent: null }] }, MAX_5X, 0)], [null, null, null]);
check('unreadable values', parseAccount({ five_hour: { utilization: 3, resets_at: 'soon' }, spend: { enabled: false, disabled_reason: 42 } }, {}, 0),
    { five_hour: { used_percentage: 3, resets_at: null }, seven_day: null, plan: null, limits: [],
        extra_usage: { enabled: false, used_percentage: null, used: null, limit: null, reason: null }, updated_at: 0 });

check('plan Max 20x', planName({ rateLimitTier: 'default_claude_max_20x' }), 'Max (20x)');
check('plan Pro', planName({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }), 'Pro');
check('plan unknown', planName({}), null);

if (failures) {
    printerr(`${failures} of ${checks} GNOME parser checks failed`);
    System.exit(1);
}
print(`ok   GNOME extension parser: ${checks} checks`);
