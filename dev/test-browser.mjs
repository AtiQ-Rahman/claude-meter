// Unit tests for the browser extension's usage parser and its message to the GNOME
// extension: node dev/test-browser.mjs
// For the real response in fixtures/usage-response.json, the message must carry what the
// GNOME extension's own parser makes of it: fixtures/usage-parsed.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUsage, parseExtraUsage, planName } from '../browser-extension/src/usage.js';
import { gnomeMessage } from '../browser-extension/src/gnome.js';

const readFixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const response = readFixture('usage-response.json');
const RESET = '2026-11-04T15:00:00+00:00';
const SESSION = { utilization: 20, resets_at: RESET };

let checks = 0;
function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (e) {
    console.error(`FAIL ${name}\n${e.message}`);
    process.exit(1);
  }
}

check('real response', () => assert.deepEqual(parseUsage(response), [
  { key: 'five_hour', label: 'Session', pct: 2, resetsAt: 1793301600437 },
  { key: 'seven_day', label: 'Week', pct: 17, resetsAt: 1793804400437 },
  { key: 'seven_day_fable', label: 'Week (Fable)', pct: 0, resetsAt: 1793804400000, gnomeTitle: 'Week · Fable' },
]));

check('real response, extra usage', () => assert.deepEqual(parseExtraUsage(response),
  { enabled: false, used_percentage: 0, used: '$0.00', limit: null, reason: 'out_of_credits' }));

check('message to GNOME', () => {
  const usage = { windows: parseUsage(response), plan: 'Max (5x)', extra: parseExtraUsage(response) };
  assert.deepEqual(gnomeMessage(usage), { ...readFixture('usage-parsed.json'), model: 'claude.ai' });
});

check('extra usage on', () => {
  const usd = amount_minor => ({ amount_minor, currency: 'USD', exponent: 2 });
  const json = { five_hour: SESSION, spend: { enabled: true, percent: 25, used: usd(1250), limit: usd(5000) } };
  assert.deepEqual(parseUsage(json).find(w => w.key === 'extra_usage'),
    { key: 'extra_usage', label: 'Extra usage', pct: 25, resetsAt: null });
  assert.deepEqual(parseExtraUsage(json),
    { enabled: true, used_percentage: 25, used: '$12.50', limit: '$50.00', reason: null });
});

check('older extra usage', () => {
  assert.equal(parseUsage({ five_hour: SESSION, extra_usage: { is_enabled: true, utilization: 10 } })
    .find(w => w.key === 'extra_usage').pct, 10);
  assert.equal(parseUsage({ five_hour: SESSION, extra_usage: { is_enabled: false, utilization: 10 } })
    .some(w => w.key === 'extra_usage'), false);
});

check('older per-model key and its limit are one window', () => assert.deepEqual(parseUsage({
  five_hour: SESSION,
  seven_day_opus: { utilization: 40, resets_at: RESET },
  limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 41, resets_at: RESET, scope: { model: { display_name: 'Opus' } } }],
}).filter(w => w.key === 'seven_day_opus'), [
  { key: 'seven_day_opus', label: 'Week (Opus)', pct: 41, resetsAt: 1793804400000, gnomeTitle: 'Week · Opus' },
]));

check('older per-model key alone', () => assert.equal(
  parseUsage({ five_hour: SESSION, seven_day_sonnet: { utilization: 3, resets_at: RESET } })
    .find(w => w.key === 'seven_day_sonnet').gnomeTitle, 'Week · Sonnet'));

check('unknown windows stay in the popup only', () => {
  const usage = { windows: parseUsage({ five_hour: SESSION, nimbus_quill: { utilization: 30 } }), plan: null, extra: null };
  assert.deepEqual(usage.windows.find(w => w.key === 'nimbus_quill'),
    { key: 'nimbus_quill', label: 'Nimbus quill', pct: 30, resetsAt: null });
  assert.deepEqual(gnomeMessage(usage).limits, []);
});

check('session and week from the list', () => {
  const windows = parseUsage({ limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 17, resets_at: RESET },
    { kind: 'session', group: 'session', percent: 9 },
  ] });
  assert.deepEqual(windows, [
    { key: 'five_hour', label: 'Session', pct: 9, resetsAt: null },
    { key: 'seven_day', label: 'Week', pct: 17, resetsAt: 1793804400000 },
  ]);
  const message = gnomeMessage({ windows, plan: null, extra: null });
  assert.deepEqual([message.five_hour, message.seven_day, message.limits],
    [{ used_percentage: 9, resets_at: null }, { used_percentage: 17, resets_at: 1793804400 }, []]);
});

check('own keys win over the list', () => assert.equal(
  parseUsage({ five_hour: { utilization: 5 }, limits: [{ kind: 'session', percent: 6 }] })
    .find(w => w.key === 'five_hour').pct, 5));

check('no windows', () => assert.throws(() => parseUsage({ limits: [], spend: null }), /No usage windows/));

check('plan', () => {
  assert.equal(planName({ rate_limit_tier: 'default_claude_max_5x', capabilities: ['claude_max'] }), 'Max (5x)');
  assert.equal(planName({ capabilities: ['chat', 'claude_max'] }), 'Max');
  assert.equal(planName({ capabilities: ['chat', 'claude_pro'] }), 'Pro');
  assert.equal(planName({ capabilities: ['chat'] }), null);
  assert.equal(planName(undefined), null);
});

console.log(`ok   browser extension parser: ${checks} checks`);
