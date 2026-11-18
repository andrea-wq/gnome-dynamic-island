#!/usr/bin/env bash
set -euo pipefail

UUID="dynamic-island@notch-dev"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions prefs "$UUID"
else
    gjs -m - "$SRC_DIR" << 'EOF'
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import System from 'system';

const srcDir = System.programArgs[0];
Gtk.init();
Adw.init();

const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    `${srcDir}/schemas`,
    Gio.SettingsSchemaSource.get_default(),
    false
);
const schema = schemaSource.lookup('org.gnome.shell.extensions.dynamic-island-notch', true);
const settings = new Gio.Settings({settings_schema: schema});

const [ok, bytes] = GLib.file_get_contents(`${srcDir}/prefs.js`);
const code = new TextDecoder().decode(bytes)
    .replace(
        "import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';",
        "class ExtensionPreferences { getSettings() { return globalThis.__standaloneSettings; } }"
    );
globalThis.__standaloneSettings = settings;

const tmpFile = `${GLib.get_tmp_dir()}/di_prefs_standalone.js`;
GLib.file_set_contents(tmpFile, code);

const {default: PrefsClass} = await import(`file://${tmpFile}`);
const app = new Adw.Application({application_id: 'org.gnome.shell.extensions.DynamicIslandNotchPrefs'});
app.connect('activate', () => {
    const win = new Adw.PreferencesWindow({
        title: 'Impostazioni GNOME Dynamic Island e Pill',
        application: app,
    });
    const prefs = new PrefsClass();
    prefs.fillPreferencesWindow(win);
    win.present();
});
app.run([]);
EOF
fi
