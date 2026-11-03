/* Claude Meter's settings window, opened from the Extensions app or the meter's menu.
 *
 * Written for GNOME 45+ (ES modules). dev/build-legacy.sh converts it for GNOME 42-44,
 * so keep imports to the one-line forms that script knows, and use only widgets that
 * libadwaita 1.1 (GNOME 42) has. */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        window.add(page);
    }
}
