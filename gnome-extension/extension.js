/* Claude Meter - top-bar vitals for Claude session (5h) and weekly limits.
 * Reads ~/.cache/claude-meter/usage.json, written by the Claude Code status line script. */

const { GObject, St, GLib, Clutter } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ByteArray = imports.byteArray;

const CACHE_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'usage.json']);
const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'claude-meter']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'settings.json']);
const ALERTS_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'alerts.json']);
const DEFAULT_CONFIG = { showSession: true, showWeekly: true, position: 'right', alerts: true };
const POSITIONS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
const REFRESH_SECONDS = 10;
const STALE_SECONDS = 15 * 60;
const BAR_WIDTH = 300;
const WARN_PCT = 80;
const CRIT_PCT = 90;
const EVERY_PCT_FROM = 95;
const SOUND_DIRS = ['Yaru', 'freedesktop'].map(theme => `/usr/share/sounds/${theme}/stereo`);

function loadConfig() {
    try {
        const [ok, bytes] = GLib.file_get_contents(CONFIG_FILE);
        if (ok) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(ByteArray.toString(bytes)));
    } catch (e) {}
    return Object.assign({}, DEFAULT_CONFIG);
}

function loadAlerts() {
    try {
        const [ok, bytes] = GLib.file_get_contents(ALERTS_FILE);
        if (ok) return JSON.parse(ByteArray.toString(bytes));
    } catch (e) {}
    return {};
}

function saveAlerts(alerts) {
    try {
        GLib.file_set_contents(ALERTS_FILE, JSON.stringify(alerts));
    } catch (e) {
        logError(e, 'claude-meter: could not save alert state');
    }
}

// Alert steps: 80, 90, then every percent from 95. 0 means no alert yet.
function alertStep(pct) {
    if (pct >= EVERY_PCT_FROM) return Math.min(pct, 100);
    if (pct >= CRIT_PCT) return CRIT_PCT;
    if (pct >= WARN_PCT) return WARN_PCT;
    return 0;
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

function saveConfig(config) {
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
        GLib.file_set_contents(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        logError(e, 'claude-meter: could not save settings');
    }
}

// Switch items close the menu on click by default; toggle in place instead.
function keepMenuOpen(item) {
    item.activate = () => item.toggle();
    return item;
}

function level(pct) {
    if (pct >= CRIT_PCT) return 'crit';
    if (pct >= WARN_PCT) return 'warn';
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

const UsageRow = GObject.registerClass(
class UsageRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({ reactive: false, can_focus: false });
        const box = new St.BoxLayout({ vertical: true, style_class: 'claude-meter-row', x_expand: true });
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

    update(state, now, withDay) {
        if (!state) {
            this._pct.text = '--';
            this._pct.style_class = 'claude-meter-stale';
            this._fill.width = 0;
            this._sub.text = 'No data yet';
            return;
        }
        const lv = level(state.pct);
        this._pct.text = `${state.pct}%`;
        this._pct.style_class = `claude-meter-${lv}`;
        this._fill.style_class = `claude-meter-fill claude-meter-fill-${lv}`;
        this._fill.width = Math.round(BAR_WIDTH * Math.min(state.pct, 100) / 100);
        this._sub.text = state.reset
            ? `Resets in ${fmtDuration(state.reset - now)} · ${fmtClock(state.reset, withDay)}`
            : 'Window reset - no new usage reported yet';
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(config, onMove) {
        super._init(0.0, 'Claude Meter');
        this._config = config;
        this._alerts = loadAlerts();
        this._notes = {};

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
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = new PopupMenu.PopupMenuItem('', { reactive: false, can_focus: false });
        this._footer.label.style_class = 'claude-meter-footer';
        this.menu.addMenuItem(this._footer);

        const settings = new PopupMenu.PopupSubMenuMenuItem('Settings');
        this.menu.addMenuItem(settings);
        const sSwitch = keepMenuOpen(new PopupMenu.PopupSwitchMenuItem('Show Session (S)', config.showSession));
        sSwitch.connect('toggled', (_i, on) => this._setOption('showSession', on));
        settings.menu.addMenuItem(sSwitch);
        const wSwitch = keepMenuOpen(new PopupMenu.PopupSwitchMenuItem('Show Week (W)', config.showWeekly));
        wSwitch.connect('toggled', (_i, on) => this._setOption('showWeekly', on));
        settings.menu.addMenuItem(wSwitch);
        const aSwitch = keepMenuOpen(new PopupMenu.PopupSwitchMenuItem('Usage alerts (sound)', config.alerts));
        aSwitch.connect('toggled', (_i, on) => this._setOption('alerts', on));
        settings.menu.addMenuItem(aSwitch);
        settings.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Position in top bar'));
        for (const [pos, name] of POSITIONS) {
            const item = new PopupMenu.PopupMenuItem(name);
            if (pos === config.position) item.setOrnament(PopupMenu.Ornament.DOT);
            item.connect('activate', () => {
                if (pos === this._config.position) return;
                this._config.position = pos;
                saveConfig(this._config);
                onMove();
            });
            settings.menu.addMenuItem(item);
        }
        this._applyVisibility();

        this.menu.connect('open-state-changed', (_m, open) => { if (open) this._refresh(); });
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _setOption(key, value) {
        this._config[key] = value;
        saveConfig(this._config);
        this._applyVisibility();
    }

    _applyVisibility() {
        this._sKey.visible = this._sLabel.visible = this._config.showSession;
        this._wKey.visible = this._wLabel.visible = this._config.showWeekly;
    }

    _read() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CACHE_FILE);
            return ok ? JSON.parse(ByteArray.toString(bytes)) : null;
        } catch (e) {
            return null;
        }
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

    _refresh() {
        const data = this._read();
        const now = Math.floor(Date.now() / 1000);
        const s = windowState(data && data.five_hour, now);
        const w = windowState(data && data.seven_day, now);
        const age = data && data.updated_at ? now - data.updated_at : null;
        const stale = age == null || age > STALE_SECONDS;

        this._setPanel(this._sLabel, s, stale);
        this._setPanel(this._wLabel, w, stale);
        const crit = !stale && ((this._config.showSession && s && s.pct >= CRIT_PCT) ||
                                (this._config.showWeekly && w && w.pct >= CRIT_PCT));
        this._box.style_class = crit ? 'claude-meter-panel claude-meter-panel-crit' : 'claude-meter-panel';
        this._checkAlert('five_hour', 'session', s, now, false);
        this._checkAlert('seven_day', 'weekly', w, now, true);
        this._sessionRow.update(s, now, false);
        this._weekRow.update(w, now, true);
        this._footer.label.text = age == null
            ? 'Waiting for Claude Code to report usage…'
            : `Updated ${fmtDuration(age)} ago${stale ? ' - open Claude Code or claude.ai to refresh' : ''}`;
    }

    _checkAlert(key, name, state, now, withDay) {
        if (!state || !state.reset) return;
        const prev = this._alerts[key];
        // resets_at identifies the window; allow some drift between reports.
        const sameWindow = prev && Math.abs(prev.window - state.reset) < 3600;
        const last = sameWindow ? prev.step : 0;
        const step = alertStep(state.pct);
        if (step > last && this._config.alerts) {
            const critical = step >= CRIT_PCT;
            playSound(critical ? 'dialog-error' : 'dialog-warning');
            this._notify(key, `Claude ${name} usage at ${state.pct}%`,
                `Resets in ${fmtDuration(state.reset - now)} (${fmtClock(state.reset, withDay)})`, critical);
        }
        if (step > last || !sameWindow) {
            this._alerts[key] = { window: state.reset, step };
            saveAlerts(this._alerts);
        }
    }

    // One notification per window type, updated in place as usage climbs.
    _notify(key, title, body, critical) {
        if (!this._source) {
            this._source = new MessageTray.Source('Claude Meter', 'dialog-warning-symbolic');
            this._source.connect('destroy', () => {
                this._source = null;
                this._notes = {};
            });
            Main.messageTray.add(this._source);
        }
        let note = this._notes[key];
        if (note) {
            note.update(title, body);
        } else {
            note = new MessageTray.Notification(this._source, title, body);
            note.connect('destroy', () => {
                if (this._notes[key] === note) delete this._notes[key];
            });
            this._notes[key] = note;
        }
        note.setUrgency(critical ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.HIGH);
        this._source.showNotification(note);
    }

    destroy() {
        if (this._source) this._source.destroy();
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        super.destroy();
    }
});

class Extension {
    enable() {
        this._addIndicator();
    }

    disable() {
        if (this._moveId) {
            GLib.source_remove(this._moveId);
            this._moveId = null;
        }
        this._indicator.destroy();
        this._indicator = null;
    }

    _addIndicator() {
        const config = loadConfig();
        this._indicator = new Indicator(config, () => this._move());
        // Right box: leftmost slot (next to other indicators). Left/center: end of the box.
        const index = config.position === 'right' ? 0 : -1;
        Main.panel.addToStatusArea('claude-meter', this._indicator, index, config.position);
    }

    // Rebuild in the new panel box once the menu has finished closing.
    _move() {
        this._indicator.menu.close();
        this._moveId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._moveId = null;
            this._indicator.destroy();
            this._addIndicator();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function init() {
    return new Extension();
}
