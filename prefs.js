import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITIONS = [
    ['notch-top', 'Notch stile macOS (agganciato al bordo superiore)'],
    ['top-center', 'Pillola fluttuante in alto al centro (sotto la Top Bar)'],
    ['panel-center', 'Integrata al centro della Top Bar'],
    ['panel-notch', 'Attorno all’orologio nella Top Bar (stile iPhone)'],
    ['panel-left', 'Top Bar a sinistra (dopo Attività)'],
    ['panel-right', 'Top Bar a destra (prima del menu di sistema)'],
    ['bottom-center', 'Pillola fluttuante in basso al centro'],
];

const IDLE_MODES = [
    ['pill-clock-ws', 'Pillola Spazi di Lavoro + Orologio'],
    ['workspace-only', 'Solo Pillola Spazi di Lavoro (stile GNOME)'],
    ['clock-only', 'Solo Orologio compatto'],
    ['hidden', 'Completamente nascosta quando inattiva'],
];

const AUTO_DODGE_MODES = [
    ['slim-clock', 'Ultra-compatta con Orologio (consigliata per Firefox/app massimizzate)'],
    ['peek-bar', 'Micro-linguetta sul bordo alto (si riapre al passaggio)'],
    ['off', 'Disattivata (sempre dimensione normale)'],
];

const TOAST_POSITIONS = [
    ['inside', 'Dentro la notch (comportamento integrato)'],
    ['below', 'Sotto la notch (pillola separata animata)'],
];

const EXPAND_ON = [
    ['hover', 'Passaggio del mouse (Hover) + Click'],
    ['click', 'Solo con il Click del mouse'],
    ['both', 'Hover o Click'],
];

const DEFAULT_TABS = [
    ['auto', 'Automatica (Media se c’è musica, altrimenti Sistema)'],
    ['media', '🎵 Media e Stato'],
    ['hub', '📊 Hub e Timer'],
    ['notes', '📝 Note Rapide'],
    ['file', '📁 Mensola File'],
    ['system', '⚙️ Sistema e Controlli Rapidi'],
];

const ANIM_STYLES = [
    ['snappy', 'Ultra-reattiva stile macOS (consigliata)'],
    ['spring', 'Elastica morbida stile iOS (con rimbalzo)'],
    ['smooth', 'Fluida progressiva'],
    ['instant', 'Istantanea (senza animazioni)'],
];

const SHAPES = [
    ['bars', 'Barre classiche (Bars)'],
    ['spectrum', 'Spettro (Spectrum)'],
    ['segments', 'Segmenti LED (Segments)'],
    ['solid', 'Onda piena (Solid)'],
    ['wave', 'Linea d’onda (Wave)'],
    ['ribbon', 'Nastro fluido (Ribbon)'],
];

const ART_SHAPES = [
    ['auto', 'Automatica (tonda chiusa, smussata aperta)'],
    ['circle', 'Cerchio'],
    ['rounded', 'Quadrato arrotondato'],
    ['square', 'Quadrato'],
];

const ART_BORDERS = [
    ['none', 'Nessuno'],
    ['subtle', 'Sottile traslucido'],
    ['white', 'Bianco'],
    ['accent', 'Colore accento'],
];

const FEATURES = [
    ['show-media', '🎵 Controlli Musica e Media (MPRIS)', 'Mostra Spotify, browser, YouTube e riproduttori multimediali'],
    ['show-volume', '🔊 OSD Volume e Luminosità', 'Sostituisce il popup grande di GNOME mostrando il livello dentro l’isola'],
    ['show-battery', '🔋 Batteria e Alimentazione', 'Mostra quando colleghi/scolleghi il caricabatterie o a carica completa'],
    ['show-bluetooth', '🎧 Dispositivi Bluetooth', 'Mostra connessione, disconnessione e batteria delle cuffie/dispositivi'],
    ['show-notifications', '🔔 Notifiche in arrivo', 'Mostra le notifiche in tempo reale nella Dynamic Island'],
    ['suppress-gnome-notification-banner', '🔕 Nascondi popup notifiche standard di GNOME', 'Evita doppi banner quando la notifica appare nella Dynamic Island'],
    ['show-workspaces', '🟣 Pillola Spazi di Lavoro (Workspaces)', 'Indicatore dinamico dei workspace (clicca per Attività, scorri con rotellina)'],
    ['show-recording', '🔴 Registrazione Schermo', 'Mostra il timer di registrazione attivo (clicca per terminare)'],
    ['show-progress', '⬇️ Avanzamento Download e File', 'Mostra la percentuale di avanzamento di copie e download'],
    ['show-system-stats', '⚡ Monitor CPU e RAM nell’Hub', 'Mostra utilizzo processore e memoria in tempo reale nella scheda Hub'],
    ['timer-sound', '⏱️ Suono fine timer nell’Hub', 'Riproduce una suoneria di sistema al termine del conto alla rovescia'],
];

export default class DynamicIslandNotchPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(680, 620);
        const settings = this.getSettings();

        // --- PAGINA 1: STILE E POSIZIONE ---
        const stylePage = new Adw.PreferencesPage({
            title: 'Stile e Posizione',
            icon_name: 'preferences-desktop-display-symbolic',
        });

        const posGroup = new Adw.PreferencesGroup({
            title: 'Posizionamento e Comportamento',
            description: 'Scegli lo stile estetico e come interagire con la Dynamic Island',
        });

        posGroup.add(this._choiceRow(settings, 'position', 'Stile e Posizione', POSITIONS));
        posGroup.add(this._choiceRow(settings, 'idle-mode', 'Stato quando inattiva', IDLE_MODES));
        posGroup.add(this._choiceRow(settings, 'auto-dodge', 'Riduzione automatica su finestre (Auto-Dodge)', AUTO_DODGE_MODES));
        posGroup.add(this._choiceRow(settings, 'toast-position', 'Avvisi Notifiche e Bluetooth', TOAST_POSITIONS));
        posGroup.add(this._choiceRow(settings, 'expand-on', 'Interazione per espandere', EXPAND_ON));
        posGroup.add(this._choiceRow(settings, 'animation-style', 'Velocità e stile animazioni', ANIM_STYLES));

        const alwaysDefaultTab = new Adw.SwitchRow({
            title: 'Apri sempre una schermata fissa ad ogni apertura',
            subtitle: 'Se disattivo, ricorda l’ultima schermata che hai visitato',
        });
        settings.bind('always-open-default-tab', alwaysDefaultTab, 'active', Gio.SettingsBindFlags.DEFAULT);
        posGroup.add(alwaysDefaultTab);

        const defaultTabRow = this._choiceRow(settings, 'default-tab', 'Schermata da aprire all’apertura', DEFAULT_TABS);
        settings.bind('always-open-default-tab', defaultTabRow, 'sensitive', Gio.SettingsBindFlags.GET);
        posGroup.add(defaultTabRow);

        const hideTopBar = new Adw.SwitchRow({
            title: 'Sostituisci interamente la barra superiore di GNOME (Top Bar)',
            subtitle: 'Nasconde la Top Bar classica di GNOME quando la Dynamic Island è attiva',
        });
        settings.bind('hide-top-bar', hideTopBar, 'active', Gio.SettingsBindFlags.DEFAULT);
        posGroup.add(hideTopBar);

        const showCompactStatus = new Adw.SwitchRow({
            title: 'Mostra icone di stato nell’isola compatta (Wi-Fi, Audio, Batteria %)',
            subtitle: 'Clicca sulle icone per aprire la scheda Sistema o scorri con la rotellina per il volume',
        });
        settings.bind('show-compact-status', showCompactStatus, 'active', Gio.SettingsBindFlags.DEFAULT);
        posGroup.add(showCompactStatus);

        const hideClock = new Adw.SwitchRow({
            title: 'Nascondi orologio centrale nativo di GNOME',
            subtitle: 'Usato solo se la Top Bar di GNOME è visibile e l’isola è al centro',
        });
        settings.bind('hide-panel-clock', hideClock, 'active', Gio.SettingsBindFlags.DEFAULT);
        posGroup.add(hideClock);
        stylePage.add(posGroup);

        const sizeGroup = new Adw.PreferencesGroup({
            title: 'Dimensioni e Margini',
        });

        const margin = new Adw.SpinRow({
            title: 'Distanza dal bordo',
            subtitle: 'In pixel (usata nella modalità Pillola fluttuante)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 200, step_increment: 1, page_increment: 10}),
        });
        settings.bind('margin', margin, 'value', Gio.SettingsBindFlags.DEFAULT);
        sizeGroup.add(margin);

        const width = new Adw.SpinRow({
            title: 'Larghezza minima compatta',
            subtitle: '0 = adattamento automatico al contenuto',
            adjustment: new Gtk.Adjustment({lower: -8, upper: 600, step_increment: 2, page_increment: 20}),
        });
        settings.bind('width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        sizeGroup.add(width);

        const expWidth = new Adw.SpinRow({
            title: 'Larghezza vista espansa',
            subtitle: 'Larghezza in pixel dell’isola aperta con le schede',
            adjustment: new Gtk.Adjustment({lower: 300, upper: 750, step_increment: 10, page_increment: 50}),
        });
        settings.bind('expanded-width', expWidth, 'value', Gio.SettingsBindFlags.DEFAULT);
        sizeGroup.add(expWidth);

        const textWidth = new Adw.SpinRow({
            title: 'Larghezza massima titoli',
            subtitle: 'I titoli più lunghi vengono abbreviati con puntini di sospensione',
            adjustment: new Gtk.Adjustment({lower: 60, upper: 500, step_increment: 10, page_increment: 40}),
        });
        settings.bind('text-width', textWidth, 'value', Gio.SettingsBindFlags.DEFAULT);
        sizeGroup.add(textWidth);

        stylePage.add(sizeGroup);
        window.add(stylePage);

        // --- PAGINA 2: MODULI E FUNZIONI ---
        const modulesPage = new Adw.PreferencesPage({
            title: 'Moduli e Funzioni',
            icon_name: 'applications-system-symbolic',
        });

        const featuresGroup = new Adw.PreferencesGroup({
            title: 'Funzioni Attive nella Dynamic Island',
            description: 'Attiva o disattiva in tempo reale i singoli moduli dell’isola',
        });

        for (const [key, title, subtitle] of FEATURES) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            featuresGroup.add(row);
        }
        modulesPage.add(featuresGroup);
        window.add(modulesPage);

        // --- PAGINA 3: MUSICA E NOTE RAPIDE ---
        const mediaNotesPage = new Adw.PreferencesPage({
            title: 'Musica e Note',
            icon_name: 'audio-x-generic-symbolic',
        });

        const visualizerGroup = new Adw.PreferencesGroup({
            title: 'Visualizer Musicale e Colore Accento',
        });
        visualizerGroup.add(this._choiceRow(settings, 'eq-style', 'Stile animazione onde sonore', SHAPES));

        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string('accent-color'));
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            rgba,
            valign: Gtk.Align.CENTER,
        });
        colorButton.connect('notify::rgba', () => {
            const {red, green, blue} = colorButton.rgba;
            settings.set_string(
                'accent-color',
                `#${[red, green, blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`
            );
        });
        settings.connect('changed::accent-color', () => {
            const color = new Gdk.RGBA();
            color.parse(settings.get_string('accent-color'));
            colorButton.rgba = color;
        });
        const resetColor = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Ripristina arancione predefinito',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetColor.connect('clicked', () => settings.reset('accent-color'));
        const colorRow = new Adw.ActionRow({
            title: 'Colore accento e visualizer',
            subtitle: 'Usato per l’equalizzatore musicale e i pulsanti principali',
        });
        colorRow.add_suffix(resetColor);
        colorRow.add_suffix(colorButton);
        visualizerGroup.add(colorRow);
        mediaNotesPage.add(visualizerGroup);

        const coverGroup = new Adw.PreferencesGroup({
            title: 'Copertina Album',
        });
        const artSize = new Adw.SpinRow({
            title: 'Dimensione copertina compatta',
            adjustment: new Gtk.Adjustment({lower: 16, upper: 40, step_increment: 1, page_increment: 4}),
        });
        settings.bind('art-size', artSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        coverGroup.add(artSize);

        const artSizeExpanded = new Adw.SpinRow({
            title: 'Dimensione copertina espansa',
            adjustment: new Gtk.Adjustment({lower: 36, upper: 120, step_increment: 2, page_increment: 8}),
        });
        settings.bind('art-size-expanded', artSizeExpanded, 'value', Gio.SettingsBindFlags.DEFAULT);
        coverGroup.add(artSizeExpanded);

        coverGroup.add(this._choiceRow(settings, 'art-shape', 'Forma copertina', ART_SHAPES));
        coverGroup.add(this._choiceRow(settings, 'art-border', 'Cornice copertina', ART_BORDERS));

        const artCompact = new Adw.SwitchRow({
            title: 'Mostra copertina nell’isola compatta',
        });
        settings.bind('art-compact', artCompact, 'active', Gio.SettingsBindFlags.DEFAULT);
        coverGroup.add(artCompact);

        const artSpin = new Adw.SwitchRow({
            title: 'Ruota copertina come un vinile',
            subtitle: 'Gira dolcemente durante la riproduzione musicale',
        });
        settings.bind('art-spin', artSpin, 'active', Gio.SettingsBindFlags.DEFAULT);
        coverGroup.add(artSpin);
        mediaNotesPage.add(coverGroup);

        const notesGroup = new Adw.PreferencesGroup({
            title: 'Gestione Note Rapide',
            description: 'Modifica o svuota gli appunti salvati nella scheda Note Rapide dell’isola',
        });
        const clearNotesBtn = new Gtk.Button({
            label: 'Svuota tutte le note',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearNotesBtn.connect('clicked', () => {
            settings.set_string('quick-notes-json', '[]');
            settings.set_string('scratchpad-text', '');
        });
        const clearNotesRow = new Adw.ActionRow({
            title: 'Cancella Note Rapide e Blocco Appunti',
            subtitle: 'Rimuove tutte le note salvate e le note fissate (Pin)',
        });
        clearNotesRow.add_suffix(clearNotesBtn);
        notesGroup.add(clearNotesRow);
        mediaNotesPage.add(notesGroup);

        window.add(mediaNotesPage);
    }

    _choiceRow(settings, key, title, choices) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(choices.map(p => p[1])),
            selected: Math.max(0, choices.findIndex(p => p[0] === settings.get_string(key))),
        });
        row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
        return row;
    }
}
