// Unit tests for gnome-extension/quota.js, outside GNOME Shell: gjs -m dev/test-quota.js
// When smart quota refresh starts a new session window, and when it leaves things alone.

import System from 'system';
import {SESSION_SECONDS, RETRY_SECONDS, smartRefreshDue} from '../gnome-extension/quota.js';

const NOW = 1793800000;
const HOUR = 3600;
const NEVER = { started_at: 0, tried_at: 0 };
const ended = { used_percentage: 40, resets_at: NOW - HOUR };

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
    checks++;
    if (actual === expected) return;
    failures++;
    printerr(`FAIL ${name}\n  expected ${expected}\n  actual   ${actual}`);
}

check('window length', SESSION_SECONDS, 5 * HOUR);
check('no reading', smartRefreshDue(null, null, NEVER, NOW), false);
check('window running', smartRefreshDue({ used_percentage: 12, resets_at: NOW + HOUR }, NOW - 60, NEVER, NOW), false);
check('window ended', smartRefreshDue(ended, NOW - 2 * HOUR, NEVER, NOW), true);
check('window ends this second', smartRefreshDue({ used_percentage: 3, resets_at: NOW }, NOW - 60, NEVER, NOW), true);
check('no window at all', smartRefreshDue({ used_percentage: 0, resets_at: null }, NOW - 60, NEVER, NOW), true);

// Started an hour ago: with no reading since, that window is taken to run for 5 hours.
const started = { started_at: NOW - HOUR, tried_at: NOW - HOUR };
check('ours running, old reading', smartRefreshDue(ended, NOW - 2 * HOUR, started, NOW), false);
check('ours running, reading from when it started', smartRefreshDue(ended, NOW - HOUR, started, NOW), false);
// A reading taken since then knows better.
check('ours ended by a newer reading', smartRefreshDue(ended, NOW - 30 * 60, started, NOW), true);
check('ours over after 5 hours', smartRefreshDue(ended, NOW - 6 * HOUR,
    { started_at: NOW - SESSION_SECONDS, tried_at: NOW - SESSION_SECONDS }, NOW), true);

// A failed try waits RETRY_SECONDS before the next.
check('failed just now', smartRefreshDue(ended, NOW - 2 * HOUR, { started_at: 0, tried_at: NOW - 60 }, NOW), false);
check('failed a while ago', smartRefreshDue(ended, NOW - 2 * HOUR, { started_at: 0, tried_at: NOW - RETRY_SECONDS }, NOW), true);

if (failures) {
    printerr(`${failures} of ${checks} smart quota refresh checks failed`);
    System.exit(1);
}
print(`ok   smart quota refresh: ${checks} checks`);
