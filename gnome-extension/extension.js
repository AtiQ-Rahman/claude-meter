/* Claude Meter - top-bar vitals for Claude session (5h) and weekly limits.
 * Reads ~/.cache/claude-meter/usage.json, written by the Claude Code status line script.
 * Snap browsers can't write there, so their native host's cache is read too, and session
 * and week each show the newest reading that has them.
 * With "Plan and model limits" turned on, it also shows the plan, per-model weekly limits
 * and extra usage: from Anthropic's usage API with Claude Code's login, or from the
 * browser extension, saved as account.json next to usage.json.
 * Settings are in GSettings (schemas/), edited in prefs.js's window. The menu's actions
 * write to a log file that View logs opens.
 *
 * Written for GNOME 45+ (ES modules). dev/build-legacy.sh converts it for GNOME 42-44,
 * so keep imports to the one-line forms that script knows. */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {parseAccount, prettify} from './account.js';
import {SESSION_SECONDS, smartRefreshDue} from './quota.js';

const CACHE_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'usage.json']);
const CACHE_FILES = [CACHE_FILE, ...['brave', 'chromium'].map(snap =>
    GLib.build_filenamev([GLib.get_home_dir(), 'snap', snap, 'common', '.cache', 'claude-meter', 'usage.json']))];
// Plan and model limits, saved next to each usage.json by the usage API fetch below
// or by the browser extension's native host.
const ACCOUNT_FILES = CACHE_FILES.map(file => GLib.build_filenamev([GLib.path_get_dirname(file), 'account.json']));
const ACCOUNT_FILE = ACCOUNT_FILES[0];
// Where settings were kept before GSettings; migrateSettings() moves them.
const OLD_CONFIG_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'claude-meter', 'settings.json']);
const ALERTS_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'alerts.json']);
const LOG_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'claude-meter.log']);
// Past this size the log starts over, keeping the previous one as claude-meter.log.old.
const LOG_MAX_BYTES = 256 * 1024;
// When smart quota refresh last started a session window, and last tried to.
const SMART_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'smart-refresh.json']);
// One tiny message through Claude Code: the smallest model, no tools, hooks, MCP servers
// or slash commands, and no session saved to its history.
const SMART_ARGS = ['-p', 'Reply with OK.', '--model', 'haiku', '--tools', '', '--no-session-persistence',
    '--strict-mcp-config', '--disable-slash-commands', '--settings', '{"disableAllHooks": true}'];
const SMART_TIMEOUT_SECONDS = 2 * 60;
const SMART_HINT = 'Starts a new window when one ends';
const CREDENTIALS_FILE = GLib.build_filenamev([
    GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']), '.credentials.json']);
// The undocumented endpoint behind Claude Code's /usage. The smoke test points it at a local server.
const USAGE_API = GLib.getenv('CLAUDE_METER_USAGE_API') || 'https://api.anthropic.com/api/oauth/usage';
const FETCH_SECONDS = 5 * 60;
// Opening the menu fetches again when the last fetch is older than this.
const OPEN_FETCH_SECONDS = 30;
// The longest a rate-limited fetch waits, whatever the server asks.
const MAX_BACKOFF_SECONDS = 60 * 60;
const REFRESH_SECONDS = 10;
const STALE_SECONDS = 15 * 60;
const BAR_WIDTH = 300;
// Values are green below YELLOW_PCT, yellow from it and red from CRIT_PCT. The alerts
// come at WARN_PCT and CRIT_PCT.
const YELLOW_PCT = 75;
const WARN_PCT = 80;
const CRIT_PCT = 90;
const EVERY_PCT_FROM = 95;
const SOUND_DIRS = ['Yaru', 'freedesktop'].map(theme => `/usr/share/sounds/${theme}/stereo`);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION);
// GNOME 46 turned Source and Notification into property-based GObjects.
const PROPERTY_NOTIFICATIONS = SHELL_MAJOR >= 46;
// GNOME 48 replaced St.BoxLayout's `vertical` with `orientation`.
const VERTICAL = SHELL_MAJOR >= 48 ? { orientation: Clutter.Orientation.VERTICAL } : { vertical: true };

// Runs one of Gio's asynchronous calls and resolves with what its finish call returns.
// All file access goes through here, so the shell never waits on the disk.
function gio(object, asyncCall, finishCall, ...args) {
    return new Promise((resolve, reject) => {
        object[asyncCall](...args, (source, result) => {
            try {
                resolve(source[finishCall](result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// The parsed JSON in a file, or null when it's missing or invalid.
function readJson(path, cancellable = null) {
    return gio(Gio.File.new_for_path(path), 'load_contents_async', 'load_contents_finish', cancellable)
        .then(([, bytes]) => JSON.parse(decoder.decode(bytes)))
        .catch(() => null);
}

// Creates a directory and its missing parents.
function makeDirs(path) {
    const dir = Gio.File.new_for_path(path);
    return gio(dir, 'make_directory_async', 'make_directory_finish', GLib.PRIORITY_DEFAULT, null).catch(e => {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) return null;
        const parent = dir.get_parent();
        if (!parent || !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw e;
        return makeDirs(parent.get_path()).then(() => makeDirs(path));
    });
}

// The newest of several readings, by updated_at. The first wins a tie.
function newest(readings) {
    let found = null;
    for (const data of readings) {
        if (data && (!found || (data.updated_at || 0) > (found.updated_at || 0))) found = data;
    }
    return found;
}

function readNewest(files, cancellable) {
    return Promise.all(files.map(file => readJson(file, cancellable))).then(newest);
}

function newestWith(readings, key) {
    return newest(readings.filter(r => r && r[key] && r[key].used_percentage != null));
}

// Seconds to wait from a Retry-After header: a number of seconds, or a date.
function retryAfter(value, now) {
    if (!value) return null;
    if (/^\s*\d+\s*$/.test(value)) return parseInt(value, 10);
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.floor(date / 1000) - now;
}

// Saves to one file go one after another, so an older save never lands last.
const saving = new Map();

// what: for the error message, e.g. "alert state".
function writeJson(path, data, what) {
    const bytes = new GLib.Bytes(encoder.encode(JSON.stringify(data)));
    const saved = (saving.get(path) || Promise.resolve())
        .then(() => makeDirs(GLib.path_get_dirname(path)))
        .then(() => gio(Gio.File.new_for_path(path), 'replace_contents_bytes_async', 'replace_contents_finish',
            bytes, null, false, Gio.FileCreateFlags.NONE, null))
        .catch(e => logError(e, `claude-meter: could not save ${what}`));
    saving.set(path, saved);
    return saved;
}

let logging = Promise.resolve();

// Adds a line to the log that View logs opens. Resolves once it is written.
function logLine(text) {
    const line = `${GLib.DateTime.new_now_local().format('%F %T')} ${text}\n`;
    logging = logging.then(() => appendLog(line)).catch(() => {});
    return logging;
}

async function appendLog(line) {
    await makeDirs(GLib.path_get_dirname(LOG_FILE));
    const file = Gio.File.new_for_path(LOG_FILE);
    const info = await gio(file, 'query_info_async', 'query_info_finish',
        'standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null).catch(() => null);
    if (info && info.get_size() > LOG_MAX_BYTES) {
        const old = Gio.File.new_for_path(`${LOG_FILE}.old`);
        await gio(old, 'delete_async', 'delete_finish', GLib.PRIORITY_DEFAULT, null).catch(() => null);
        await gio(file, 'set_display_name_async', 'set_display_name_finish', old.get_basename(), GLib.PRIORITY_DEFAULT, null);
    }
    const stream = await gio(file, 'append_to_async', 'append_to_finish', Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    try {
        let bytes = encoder.encode(line);
        while (bytes.length > 0) {
            const written = await gio(stream, 'write_bytes_async', 'write_bytes_finish',
                new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, null);
            if (written <= 0) throw new Error('nothing written');
            bytes = bytes.subarray(written);
        }
    } finally {
        await gio(stream, 'close_async', 'close_finish', GLib.PRIORITY_DEFAULT, null);
    }
}

// Settings used to be kept in a JSON file. Moves them into GSettings and removes it.
async function migrateSettings(settings) {
    const old = await readJson(OLD_CONFIG_FILE);
    if (!old || typeof old !== 'object') return;
    for (const [from, to] of [['showSession', 'show-session'], ['showWeekly', 'show-weekly'],
        ['alerts', 'usage-alerts'], ['account', 'plan-and-model-limits']]) {
        if (typeof old[from] === 'boolean') settings.set_boolean(to, old[from]);
    }
    if (['left', 'center', 'right'].includes(old.position)) settings.set_string('position', old.position);
    try {
        await gio(Gio.File.new_for_path(OLD_CONFIG_FILE), 'delete_async', 'delete_finish', GLib.PRIORITY_DEFAULT, null);
        logLine(`Moved the settings in ${OLD_CONFIG_FILE} to GSettings`);
    } catch (e) {
        logError(e, 'claude-meter: could not remove the old settings file');
    }
}

// Claude Code's command. GNOME Shell's PATH can lack ~/.local/bin, where its installer puts it.
function findClaude() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
    return GLib.find_program_in_path('claude') ||
        (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

function versionName(metadata) {
    return String(metadata['version-name'] || metadata.version || '');
}

// Alert steps: 80, 90, then every percent from 95. 0 means no alert yet.
function alertStep(pct) {
    if (pct >= EVERY_PCT_FROM) return Math.min(pct, 100);
    if (pct >= CRIT_PCT) return CRIT_PCT;
    if (pct >= WARN_PCT) return WARN_PCT;
    return 0;
}

// "Week · Fable" -> "Fable weekly", for alert titles.
function alertName(title) {
    const [base, what] = title.split(' · ');
    const kind = base === 'Week' ? 'weekly' : base.toLowerCase();
    return what ? `${what} ${kind}` : kind;
}

function playSound(name) {
    const file = SOUND_DIRS.map(dir => `${dir}/${name}.oga`)
        .find(f => GLib.file_test(f, GLib.FileTest.EXISTS));
    try {
        // paplay plays even when desktop event sounds are turned off.
        if (!file) throw new Error(`no sound file for ${name}`);
        GLib.spawn_async(null, ['paplay', file], null, GLib.SpawnFlags.SEARCH_PATH, null);
    } catch (e) {
        global.display.get_sound_player().play_from_theme(name, 'Claude Meter alert', null);
    }
}

// Switch items close the menu on click by default; toggle in place instead.
function keepMenuOpen(item) {
    item.activate = () => item.toggle();
    return item;
}

function menuItem(text, shortcut = null) {
    const item = new PopupMenu.PopupMenuItem(text);
    if (shortcut) {
        item.add_child(new St.Label({
            text: shortcut, style_class: 'claude-meter-shortcut', x_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    return item;
}

function noteItem(text = '') {
    const item = new PopupMenu.PopupMenuItem(text, { reactive: false, can_focus: false });
    item.label.style_class = 'claude-meter-footer';
    return item;
}

function level(pct) {
    if (pct >= CRIT_PCT) return 'crit';
    if (pct >= YELLOW_PCT) return 'warn';
    return 'ok';
}

function fmtDuration(secs) {
    secs = Math.max(0, Math.floor(secs));
    const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function fmtClock(epoch, withDay) {
    const dt = GLib.DateTime.new_from_unix_local(epoch);
    return dt.format(withDay ? '%a %-I:%M %p' : '%-I:%M %p');
}

// Usage % for a window, treating a window whose reset time has passed as 0.
function windowState(w, now) {
    if (!w || w.used_percentage == null) return null;
    const reset = w.resets_at;
    if (reset && reset <= now) return { pct: 0, reset: null };
    return { pct: Math.round(w.used_percentage), reset };
}

// Show the weekday in a reset time more than a day away.
function farReset(state, now) {
    return !!state && !!state.reset && state.reset - now >= 86400;
}

// GNOME 42 runs libsoup 2, GNOME 43 and later libsoup 3. Calls done(status, body, headers).
function httpGet(session, url, headers, done) {
    const msg = Soup.Message.new('GET', url);
    for (const [name, value] of Object.entries(headers)) msg.request_headers.append(name, value);
    if (typeof session.send_and_read_async === 'function') {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            let body = null;
            try {
                body = decoder.decode(s.send_and_read_finish(res).get_data());
            } catch (e) {}
            done(msg.status_code, body, msg.response_headers);
        });
    } else {
        session.queue_message(msg, () => done(msg.status_code, msg.response_body.data, msg.response_headers));
    }
}

const UsageRow = GObject.registerClass(
class UsageRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ ...VERTICAL, style_class: 'claude-meter-row', x_expand: true });
        const head = new St.BoxLayout({ x_expand: true });
        this._title = new St.Label({ text: title, style_class: 'claude-meter-row-title', x_expand: true });
        this._pct = new St.Label({ text: '--' });
        head.add_child(this._title);
        head.add_child(this._pct);

        this._track = new St.Widget({ style_class: 'claude-meter-track', width: BAR_WIDTH });
        this._fill = new St.Widget({ style_class: 'claude-meter-fill', width: 0 });
        this._track.add_child(this._fill);

        this._sub = new St.Label({ text: '', style_class: 'claude-meter-row-sub' });
        box.add_child(head);
        box.add_child(this._track);
        box.add_child(this._sub);
        this.add_child(box);
    }

    // withDay: show the weekday in the reset time. note: shown instead of the reset time.
    // stale: grey, for a reading too old to trust.
    update(state, now, { withDay = false, note = null, stale = false } = {}) {
        if (!state) {
            this.setOff('--', 'No data yet');
            return;
        }
        const lv = stale ? 'stale' : level(state.pct);
        this._pct.text = `${state.pct}%`;
        this._pct.style_class = `claude-meter-${lv}`;
        this._fill.style_class = `claude-meter-fill claude-meter-fill-${lv}`;
        this._fill.width = Math.round(BAR_WIDTH * Math.min(state.pct, 100) / 100);
        this._sub.text = note || (state.reset
            ? `Resets in ${fmtDuration(state.reset - now)} · ${fmtClock(state.reset, withDay)}`
            : 'Window reset - no new usage reported yet');
    }

    // No reading, or a limit that's not in use, such as extra usage turned off.
    setOff(text, note) {
        this._pct.text = text;
        this._pct.style_class = 'claude-meter-stale';
        this._fill.width = 0;
        this._sub.text = note;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    // actions: openPreferences() and quit(), which the extension carries out.
    _init(settings, version, actions) {
        super._init(0.0, 'Claude Meter');
        this._settings = settings;
        this._actions = actions;
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._refreshes = 0;
        this._alerts = {};
        this._notes = {};
        this._smart = { started_at: 0, tried_at: 0 };
        // Refreshes wait for this, so an alert that already fired doesn't fire again.
        this._ready = Promise.all([readJson(ALERTS_FILE, this._cancellable), readJson(SMART_FILE, this._cancellable)])
            .then(([alerts, smart]) => {
                if (alerts && typeof alerts === 'object') this._alerts = alerts;
                if (smart && typeof smart === 'object') Object.assign(this._smart, smart);
            });

        const box = this._box = new St.BoxLayout({ style_class: 'claude-meter-panel', y_align: Clutter.ActorAlign.CENTER });
        box.add_child(new St.Label({ text: '✳', style_class: 'claude-meter-icon', y_align: Clutter.ActorAlign.CENTER }));
        this._sKey = new St.Label({ text: 'S', style_class: 'claude-meter-key', y_align: Clutter.ActorAlign.CENTER });
        this._sLabel = new St.Label({ text: '--', y_align: Clutter.ActorAlign.CENTER });
        this._wKey = new St.Label({ text: 'W', style_class: 'claude-meter-key', y_align: Clutter.ActorAlign.CENTER });
        this._wLabel = new St.Label({ text: '--', y_align: Clutter.ActorAlign.CENTER });
        [this._sKey, this._sLabel, this._wKey, this._wLabel].forEach(l => box.add_child(l));
        this.add_child(box);

        this._sessionRow = new UsageRow('Session (5 hours)');
        this._weekRow = new UsageRow('Week (7 days)');
        this.menu.addMenuItem(this._sessionRow);
        this.menu.addMenuItem(this._weekRow);
        // Rows only the account details have, such as one model's weekly limit.
        this._accountSection = new PopupMenu.PopupMenuSection();
        this._accountTitles = '';
        this._accountRows = [];
        this._lastFetch = 0;
        // No fetch before this time, after the usage API said it got too many requests.
        this._retryAt = 0;
        this.menu.addMenuItem(this._accountSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = noteItem();
        this.menu.addMenuItem(this._footer);
        // Why the plan and model limits are missing or old, when they are.
        this._note = noteItem();
        this._note.visible = false;
        this.menu.addMenuItem(this._note);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = menuItem('Refresh now', 'Ctrl+R');
        // In place, so the menu stays open to show what it found.
        refresh.activate = () => this._refreshNow();
        this.menu.addMenuItem(refresh);
        this._smartOn = settings.get_boolean('smart-quota-refresh');
        this._smartSwitch = keepMenuOpen(new PopupMenu.PopupSwitchMenuItem('Smart quota refresh', this._smartOn));
        this._smartSwitch.connect('toggled', (_i, on) => settings.set_boolean('smart-quota-refresh', on));
        this.menu.addMenuItem(this._smartSwitch);
        this._smartNote = noteItem(SMART_HINT);
        this._smartNote.label.add_style_class_name('claude-meter-hint');
        this.menu.addMenuItem(this._smartNote);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = menuItem('Settings…', 'Ctrl+,');
        prefs.connect('activate', () => actions.openPreferences());
        this.menu.addMenuItem(prefs);
        const logs = menuItem('View logs');
        logs.connect('activate', () => this._viewLogs());
        this.menu.addMenuItem(logs);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(noteItem(`Version ${version}`));
        const quit = menuItem('Quit Claude Meter', 'Ctrl+Q');
        quit.connect('activate', () => actions.quit());
        this.menu.addMenuItem(quit);
        this._watchKeys();

        this._settingsIds = [
            ...['show-session', 'show-weekly'].map(key => settings.connect(`changed::${key}`, () => {
                this._applyVisibility();
                this._refresh();
            })),
            settings.connect('changed::plan-and-model-limits', () => {
                this._fetchAccount(0);
                this._refresh();
            }),
            settings.connect('changed::smart-quota-refresh', () => {
                // Some settings backends tell about one change twice.
                const on = settings.get_boolean('smart-quota-refresh');
                if (on === this._smartOn) return;
                this._smartOn = on;
                this._smartSwitch.setToggleState(on);
                this._smartError = null;
                logLine(`Smart quota refresh turned ${on ? 'on' : 'off'}`);
                this._refresh();
            }),
        ];
        this._applyVisibility();

        this._menuOpenId = this.menu.connect('open-state-changed', (_m, open) => {
            if (!open) return;
            this._fetchAccount(OPEN_FETCH_SECONDS);
            this._refresh();
        });
        this._fetchAccount(FETCH_SECONDS);
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._fetchAccount(FETCH_SECONDS);
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyVisibility() {
        this._sKey.visible = this._sLabel.visible = this._settings.get_boolean('show-session');
        this._wKey.visible = this._wLabel.visible = this._settings.get_boolean('show-weekly');
    }

    // Ctrl+R, Ctrl+, and Ctrl+Q while the menu is open. Newer GNOME versions hand keys to
    // event controllers, older ones to the key-press-event signal.
    _watchKeys() {
        const onKey = (symbol, state) => {
            if (!(state & Clutter.ModifierType.CONTROL_MASK)) return Clutter.EVENT_PROPAGATE;
            if (symbol === Clutter.KEY_r || symbol === Clutter.KEY_R) {
                this._refreshNow();
            } else if (symbol === Clutter.KEY_comma) {
                this.menu.close();
                this._actions.openPreferences();
            } else if (symbol === Clutter.KEY_q || symbol === Clutter.KEY_Q) {
                this._actions.quit();
            } else {
                return Clutter.EVENT_PROPAGATE;
            }
            return Clutter.EVENT_STOP;
        };
        if (Clutter.KeyController) {
            const keys = this._keys = new Clutter.KeyController();
            this._keysId = keys.connect('key-press', () => {
                const [, symbol] = keys.get_key();
                const [, pressed, latched, locked] = keys.get_state();
                return onKey(symbol, pressed | latched | locked);
            });
            this.menu.actor.add_action(keys);
        } else {
            this._keyPressId = this.menu.actor.connect('key-press-event',
                (_a, event) => onKey(event.get_key_symbol(), event.get_state()));
        }
    }

    // Reads the files again and, with plan and model limits on, asks the usage API now.
    _refreshNow() {
        logLine('Refresh now');
        this._fetchAccount(0);
        this._refresh();
    }

    _viewLogs() {
        // Also creates the file, should nothing have been logged yet.
        logLine('View logs').then(() => {
            try {
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(LOG_FILE, null),
                    global.create_app_launch_context(0, -1));
            } catch (e) {
                Main.notifyError('Claude Meter could not open its log', `${LOG_FILE}: ${e.message}`);
            }
        });
    }

    // Asks the usage API for the plan and limits when the newest saved copy is older
    // than maxAge seconds, trying at most once per maxAge. Resolves once done.
    _fetchAccount(maxAge) {
        const now = Math.floor(Date.now() / 1000);
        if (!this._settings.get_boolean('plan-and-model-limits') || this._fetching || now - this._lastFetch < maxAge)
            return Promise.resolve();
        this._fetching = true;
        return Promise.all([readNewest(ACCOUNT_FILES, this._cancellable), readJson(CREDENTIALS_FILE, this._cancellable)])
            .then(([saved, credentials]) => {
                if (this._destroyed || (saved && now - saved.updated_at < maxAge)) return null;
                const oauth = (credentials || {}).claudeAiOauth;
                // Without Claude Code, the browser extension can still supply them.
                if (!oauth || !oauth.accessToken) {
                    this._setLoginState('missing');
                    return null;
                }
                // Only Claude Code renews its login: renewing it here would sign Claude Code out.
                if (oauth.expiresAt < Date.now()) {
                    this._setLoginState('expired');
                    return null;
                }
                if (now < this._retryAt) return null;
                this._lastFetch = now;
                return this._request(oauth);
            })
            .catch(e => logError(e, 'claude-meter: could not fetch account usage'))
            .finally(() => {
                this._fetching = false;
            });
    }

    _request(oauth) {
        if (!this._http) this._http = new Soup.Session({ timeout: 20, user_agent: 'claude-meter' });
        return new Promise(resolve => httpGet(this._http, USAGE_API, {
            'Authorization': `Bearer ${oauth.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'Accept': 'application/json',
        }, (status, body, headers) => {
            if (this._destroyed) {
                resolve();
                return;
            }
            const time = Math.floor(Date.now() / 1000);
            if (status === 401) {
                this._setLoginState('expired');
                resolve(this._refresh());
                return;
            }
            if (status === 429) {
                // Too many requests: wait as long as the server asks, or twice the usual time.
                const wait = retryAfter(headers && headers.get_one('Retry-After'), time);
                this._retryAt = time + Math.min(Math.max(wait == null ? 2 * FETCH_SECONDS : wait, 0), MAX_BACKOFF_SECONDS);
                this._logFetchError('HTTP 429', `asking again in ${fmtDuration(this._retryAt - time)}`);
                resolve();
                return;
            }
            let json = null;
            try {
                json = JSON.parse(body);
            } catch (e) {}
            if (status !== 200 || !json || typeof json !== 'object') {
                this._logFetchError(status ? `HTTP ${status}` : 'no response');
                resolve();
                return;
            }
            this._setLoginState('ok');
            const account = parseAccount(json, oauth, time);
            if (!account) {
                this._logFetchError('no usage limits in the response');
                resolve();
                return;
            }
            this._fetchError = null;
            logLine('Usage API: updated the plan and model limits');
            // Shown once saved, as the menu reads it back from the file.
            resolve(writeJson(ACCOUNT_FILE, account, 'account usage').then(() => this._refresh()));
        }));
    }

    // Logs each new kind of failure to the system log once instead of every few minutes,
    // and every one to View logs. An expired or missing login only goes to View logs: the
    // menu explains it.
    _logFetchError(reason, detail = '') {
        if (reason !== this._fetchError) log(`claude-meter: could not fetch account usage: ${reason}`);
        this._fetchError = reason;
        logLine(`Usage API: could not fetch: ${reason}${detail ? `, ${detail}` : ''}`);
    }

    // state: 'ok', 'missing' or 'expired', for _accountNote().
    _setLoginState(state) {
        if (state !== this._loginState && state === 'missing') logLine('Usage API: no Claude Code login found');
        if (state !== this._loginState && state === 'expired') logLine('Usage API: Claude Code login expired');
        this._loginState = state;
    }

    _setPanel(label, state, stale) {
        if (!state) {
            label.text = '--';
            label.style_class = 'claude-meter-stale';
            return;
        }
        label.text = `${state.pct}%`;
        label.style_class = stale ? 'claude-meter-stale' : `claude-meter-${level(state.pct)}`;
    }

    // Reads the usage files, then updates the top bar and the menu. When refreshes
    // overlap, only the last one shows. Resolves once shown.
    _refresh() {
        const refresh = ++this._refreshes;
        const files = CACHE_FILES.concat(this._settings.get_boolean('plan-and-model-limits') ? ACCOUNT_FILES : []);
        return this._ready
            .then(() => Promise.all(files.map(file => readJson(file, this._cancellable))))
            .then(results => {
                if (this._destroyed || refresh !== this._refreshes) return;
                this._show(results.slice(0, CACHE_FILES.length),
                    results.slice(CACHE_FILES.length).filter(a => a && typeof a.updated_at === 'number'));
            })
            .catch(e => logError(e, 'claude-meter: could not refresh'));
    }

    _show(caches, accounts) {
        const now = Math.floor(Date.now() / 1000);
        const account = newest(accounts);
        // All of them report session and week. Each shows the newest reading that has it, so
        // a reading without them, such as a usage API response in a new shape, hides nothing.
        const readings = caches.concat(accounts);
        const sData = newestWith(readings, 'five_hour');
        const wData = newestWith(readings, 'seven_day');
        const s = windowState(sData && sData.five_hour, now);
        const w = windowState(wData && wData.seven_day, now);
        const isStale = data => !data || !data.updated_at || now - data.updated_at > STALE_SECONDS;
        const sStale = isStale(sData);
        const wStale = isStale(wData);
        // The footer's update time: of the newest reading shown, or of any.
        const shown = newest([sData, wData]) || newest(readings);
        const age = shown && shown.updated_at ? now - shown.updated_at : null;
        const stale = age == null || age > STALE_SECONDS;
        const accountStale = !!account && now - account.updated_at > STALE_SECONDS;
        const limits = account && Array.isArray(account.limits)
            ? account.limits.filter(l => l && typeof l.title === 'string')
            : [];
        const extra = account && account.extra_usage && typeof account.extra_usage === 'object'
            ? account.extra_usage
            : null;

        this._setPanel(this._sLabel, s, sStale);
        this._setPanel(this._wLabel, w, wStale);
        // Red when a shown value is critical, or any per-model limit is.
        const limitCrit = !accountStale && limits.some(l => {
            const state = windowState(l, now);
            return !!state && state.pct >= CRIT_PCT;
        });
        const crit = limitCrit ||
            (this._settings.get_boolean('show-session') && !sStale && s && s.pct >= CRIT_PCT) ||
            (this._settings.get_boolean('show-weekly') && !wStale && w && w.pct >= CRIT_PCT);
        this._box.style_class = crit ? 'claude-meter-panel claude-meter-panel-crit' : 'claude-meter-panel';
        this._checkAlert('five_hour', 'session', s, now, false);
        this._checkAlert('seven_day', 'weekly', w, now, true);
        for (const l of limits) {
            const state = windowState(l, now);
            this._checkAlert(`limit:${l.title}`, alertName(l.title), state, now, farReset(state, now));
        }
        this._sessionRow.update(s, now, { stale: sStale });
        this._weekRow.update(w, now, { withDay: true, stale: wStale });
        this._updateAccountRows(limits, extra, accountStale, now);
        const plan = account && typeof account.plan === 'string' ? account.plan : null;
        this._footer.label.text = age == null
            ? 'Waiting for Claude Code to report usage…'
            : `${plan ? `${plan} · updated` : 'Updated'} ${fmtDuration(age)} ago${stale ? ' - open Claude Code or claude.ai to refresh' : ''}`;
        const note = this._accountNote(account, now);
        this._note.label.text = note;
        this._note.visible = note !== '';
        this._checkSmartRefresh(sData, now);
        this._smartNote.label.text = this._smartStatus(now);
    }

    _checkSmartRefresh(sData, now) {
        if (!this._settings.get_boolean('smart-quota-refresh') || this._smartProc || this._smartStarting) return;
        if (smartRefreshDue(sData && sData.five_hour, sData && sData.updated_at, this._smart, now)) this._startWindow(now);
    }

    // Starts a new session window with a one-word reply. Claude Code sends it, with its own
    // login, which it renews when needed.
    _startWindow(now) {
        this._smart.tried_at = now;
        writeJson(SMART_FILE, this._smart, 'smart quota refresh state');
        const claude = findClaude();
        if (!claude) {
            this._smartError = 'Needs Claude Code';
            logLine('Smart quota refresh: Claude Code (claude) not found');
            return;
        }
        logLine('Smart quota refresh: the session window has ended, starting a new one');
        // Away from any project, so no project settings or CLAUDE.md apply.
        const dir = GLib.path_get_dirname(SMART_FILE);
        this._smartStarting = true;
        makeDirs(dir).catch(() => null).then(() => {
            this._smartStarting = false;
            if (!this._destroyed) this._runClaude(claude, dir);
        });
    }

    _runClaude(claude, dir) {
        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.set_cwd(dir);
            launcher.set_stdin_file_path('/dev/null');
            proc = launcher.spawnv([claude, ...SMART_ARGS]);
        } catch (e) {
            this._smartError = 'Could not start a window - see View logs';
            logLine(`Smart quota refresh: could not run ${claude}: ${e.message}`);
            this._refresh();
            return;
        }
        this._smartProc = proc;
        this._smartCancel = new Gio.Cancellable();
        this._smartTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SMART_TIMEOUT_SECONDS, () => {
            this._smartTimeout = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, this._smartCancel, (p, res) => {
            let stderr = '';
            try {
                [, , stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                stderr = e.message;
            }
            if (this._smartProc !== proc) return; // destroyed
            this._smartProc = null;
            if (this._smartTimeout) {
                GLib.source_remove(this._smartTimeout);
                this._smartTimeout = 0;
            }
            if (p.get_successful()) {
                this._smart.started_at = Math.floor(Date.now() / 1000);
                this._smartError = null;
                writeJson(SMART_FILE, this._smart, 'smart quota refresh state');
                logLine('Smart quota refresh: started a new session window');
                this._fetchAccount(0);
            } else {
                this._smartError = 'Could not start a window - see View logs';
                const why = (stderr || '').trim().slice(0, 500) || 'no error message';
                logLine(`Smart quota refresh: ${claude} failed: ${why}`);
            }
            this._refresh();
        });
    }

    // The line under the smart quota refresh switch.
    _smartStatus(now) {
        if (!this._settings.get_boolean('smart-quota-refresh')) return SMART_HINT;
        if (this._smartProc || this._smartStarting) return 'Starting a new window…';
        if (this._smartError) return this._smartError;
        if (this._smart.started_at && now < this._smart.started_at + SESSION_SECONDS)
            return `Started a new window at ${fmtClock(this._smart.started_at, false)}`;
        return SMART_HINT;
    }

    // A row per limit beyond session and week, then extra usage. The rows are only
    // rebuilt when the set of limits changes.
    _updateAccountRows(limits, extra, stale, now) {
        const titles = limits.map(l => l.title).concat(extra ? ['Extra usage'] : []);
        if (titles.join('\n') !== this._accountTitles) {
            this._accountTitles = titles.join('\n');
            this._accountSection.removeAll();
            this._accountRows = titles.map(title => {
                const row = new UsageRow(title);
                this._accountSection.addMenuItem(row);
                return row;
            });
        }
        limits.forEach((l, i) => {
            const state = windowState(l, now);
            this._accountRows[i].update(state, now, { withDay: farReset(state, now), stale });
        });
        if (!extra) return;
        const row = this._accountRows[limits.length];
        if (!extra.enabled) {
            row.setOff('Off', typeof extra.reason === 'string' && extra.reason ? prettify(extra.reason) : 'Turned off');
            return;
        }
        const spent = extra.used && extra.limit ? `${extra.used} of ${extra.limit} used`
            : extra.used ? `${extra.used} used` : 'Turned on';
        row.update({ pct: Math.round(extra.used_percentage || 0), reset: null }, now, { note: spent, stale });
    }

    _accountNote(account, now) {
        if (!this._settings.get_boolean('plan-and-model-limits') || (account && now - account.updated_at <= STALE_SECONDS)) return '';
        if (this._loginState === 'expired') return 'Claude Code login expired - open Claude Code';
        if (account) return `Limits updated ${fmtDuration(now - account.updated_at)} ago`;
        if (this._loginState === 'missing') return 'Needs Claude Code or the browser extension';
        return '';
    }

    _checkAlert(key, name, state, now, withDay) {
        if (!state || !state.reset) return;
        const prev = this._alerts[key];
        // resets_at identifies the window; allow some drift between reports.
        const sameWindow = prev && Math.abs(prev.window - state.reset) < 3600;
        const last = sameWindow ? prev.step : 0;
        const step = alertStep(state.pct);
        if (step > last && this._settings.get_boolean('usage-alerts')) {
            const critical = step >= CRIT_PCT;
            logLine(`Alert: Claude ${name} usage at ${state.pct}%`);
            playSound(critical ? 'dialog-error' : 'dialog-warning');
            this._notify(key, `Claude ${name} usage at ${state.pct}%`,
                `Resets in ${fmtDuration(state.reset - now)} (${fmtClock(state.reset, withDay)})`, critical);
        }
        if (step > last || !sameWindow) {
            this._alerts[key] = { window: state.reset, step };
            writeJson(ALERTS_FILE, this._alerts, 'alert state');
        }
    }

    // One notification per window type, updated in place as usage climbs.
    _notify(key, title, body, critical) {
        if (!this._source) {
            this._source = PROPERTY_NOTIFICATIONS
                ? new MessageTray.Source({ title: 'Claude Meter', iconName: 'dialog-warning-symbolic' })
                : new MessageTray.Source('Claude Meter', 'dialog-warning-symbolic');
            this._sourceDestroyId = this._source.connect('destroy', () => {
                this._source = null;
                this._notes = {};
            });
            Main.messageTray.add(this._source);
        }
        const urgency = critical ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.HIGH;
        let note = this._notes[key] && this._notes[key].note;
        if (note) {
            if (PROPERTY_NOTIFICATIONS) note.set({ title, body });
            else note.update(title, body);
        } else {
            note = PROPERTY_NOTIFICATIONS
                ? new MessageTray.Notification({ source: this._source, title, body })
                : new MessageTray.Notification(this._source, title, body);
            const destroyId = note.connect('destroy', () => {
                if (this._notes[key] && this._notes[key].note === note) delete this._notes[key];
            });
            this._notes[key] = { note, destroyId };
        }
        if (PROPERTY_NOTIFICATIONS) {
            note.urgency = urgency;
            // Un-acknowledging shows the banner again for a notification already in the tray.
            note.acknowledged = false;
            this._source.addNotification(note);
        } else {
            note.setUrgency(urgency);
            this._source.showNotification(note);
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this.menu.disconnect(this._menuOpenId);
        if (this._keysId) this._keys.disconnect(this._keysId);
        if (this._keyPressId) this.menu.actor.disconnect(this._keyPressId);
        if (this._smartProc) {
            this._smartCancel.cancel();
            this._smartProc.force_exit();
            this._smartProc = null;
        }
        if (this._smartTimeout) {
            GLib.source_remove(this._smartTimeout);
            this._smartTimeout = 0;
        }
        if (this._source) {
            for (const { note, destroyId } of Object.values(this._notes)) note.disconnect(destroyId);
            this._source.disconnect(this._sourceDestroyId);
            this._source.destroy();
            this._source = null;
        }
        if (this._http) {
            this._http.abort();
            this._http = null;
        }
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        super.destroy();
    }
});

// Quit hides Claude Meter until the next login. The flag lives in the module, which
// stays loaded while locking the screen disables and enables the extension, and goes
// away with GNOME Shell.
let quitUntilLogin = false;

export default class ClaudeMeterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        migrateSettings(this._settings);
        logLine(`Claude Meter ${versionName(this.metadata)} on GNOME Shell ${Config.PACKAGE_VERSION}`);
        this._positionId = this._settings.connect('changed::position', () => this._rebuild());
        if (!quitUntilLogin) this._addIndicator();
    }

    disable() {
        // Locking the screen disables extensions too; only switching it off forgets Quit.
        if (!Main.sessionMode.isLocked) quitUntilLogin = false;
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = null;
        }
        this._settings.disconnect(this._positionId);
        this._settings = null;
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _addIndicator() {
        const position = this._settings.get_string('position');
        this._indicator = new Indicator(this._settings, versionName(this.metadata), {
            openPreferences: () => this.openPreferences(),
            quit: () => this._quit(),
        });
        // Right box: leftmost slot (next to other indicators). Left/center: end of the box.
        const index = position === 'right' ? 0 : -1;
        Main.panel.addToStatusArea('claude-meter', this._indicator, index, position);
    }

    _quit() {
        if (quitUntilLogin) return;
        quitUntilLogin = true;
        logLine('Quit: hidden until the next login');
        Main.notify('Claude Meter is hidden until you log in again',
            'To bring it back sooner, switch it off and on in the Extensions app.');
        this._rebuild();
    }

    // Takes the indicator down once its menu has finished closing, and puts it back in the
    // part of the top bar the settings name, unless quitting.
    _rebuild() {
        if (!this._indicator || this._rebuildId) return;
        this._indicator.menu.close();
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = null;
            this._indicator.destroy();
            this._indicator = null;
            if (!quitUntilLogin) this._addIndicator();
            return GLib.SOURCE_REMOVE;
        });
    }
}
