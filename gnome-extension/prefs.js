/* Claude Meter's settings window, opened from the Extensions app or the meter's menu.
 *
 * Written for GNOME 45+ (ES modules). dev/build-legacy.sh converts it for GNOME 42-44,
 * so keep imports to the one-line forms that script knows, and use only widgets that
 * libadwaita 1.1 (GNOME 42) has. */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The log the extension writes: when it started, alerts, usage API requests, smart quota refresh.
const LOG_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-meter', 'claude-meter.log']);

const POSITIONS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({ title, subtitle });
    const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    return row;
}

function positionRow(settings) {
    const row = new Adw.ComboRow({
        title: 'Position in top bar',
        model: Gtk.StringList.new(POSITIONS.map(([, name]) => name)),
    });
    const sync = () => {
        row.selected = Math.max(0, POSITIONS.findIndex(([nick]) => nick === settings.get_string('position')));
    };
    sync();
    const changed = settings.connect('changed::position', sync);
    row.connect('notify::selected', () => {
        const [nick] = POSITIONS[row.selected];
        if (settings.get_string('position') !== nick) settings.set_string('position', nick);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}

// Opens the log in the default text editor, creating it should nothing have been logged yet.
function logsRow() {
    const row = new Adw.ActionRow({ title: 'View logs', subtitle: LOG_FILE.replace(GLib.get_home_dir(), '~') });
    const button = new Gtk.Button({ label: 'Open', valign: Gtk.Align.CENTER });
    button.connect('clicked', () => {
        try {
            if (!GLib.file_test(LOG_FILE, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(GLib.path_get_dirname(LOG_FILE), 0o755);
                GLib.file_set_contents(LOG_FILE, '');
            }
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(LOG_FILE, null), null);
        } catch (e) {
            row.subtitle = `Could not open ${LOG_FILE}: ${e.message}`;
        }
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

export default class ClaudeMeterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const bar = new Adw.PreferencesGroup({ title: 'Top bar' });
        bar.add(switchRow(settings, 'show-session', 'Show Session (S)', 'Usage of the 5-hour session limit'));
        bar.add(switchRow(settings, 'show-weekly', 'Show Week (W)', 'Usage of the 7-day limit'));
        bar.add(positionRow(settings));
        page.add(bar);

        const usage = new Adw.PreferencesGroup({ title: 'Usage' });
        usage.add(switchRow(settings, 'usage-alerts', 'Usage alerts (sound)',
            'At 80% and 90%, then at every percent from 95%'));
        usage.add(switchRow(settings, 'plan-and-model-limits', 'Plan and model limits',
            "Your plan, per-model weekly limits and extra usage, from Anthropic's usage API with Claude Code's login"));
        usage.add(switchRow(settings, 'smart-quota-refresh', 'Smart quota refresh',
            'Starts a new 5-hour window as soon as one ends, with one tiny message through Claude Code'));
        page.add(usage);

        const about = new Adw.PreferencesGroup({ title: 'About' });
        const version = new Adw.ActionRow({ title: 'Version' });
        version.add_suffix(new Gtk.Label({
            label: String(this.metadata['version-name'] || this.metadata.version || ''),
            css_classes: ['dim-label'],
        }));
        about.add(version);
        about.add(logsRow());
        page.add(about);

        window.add(page);
    }
}
