import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DynamicIslandNotchExtension extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        this._island = null;
        this._sources = null;

        const v = `?v=${Date.now()}`;
        Promise.all([
            import(`./island.js${v}`),
            import(`./sources/media.js${v}`),
            import(`./sources/osd.js${v}`),
            import(`./sources/battery.js${v}`),
            import(`./sources/bluetooth.js${v}`),
            import(`./sources/notifications.js${v}`),
            import(`./sources/recording.js${v}`),
            import(`./sources/progress.js${v}`),
            import(`./sources/systemControls.js${v}`),
            import(`./sources/systemStats.js${v}`),
            import(`./sources/fileShelf.js${v}`),
        ]).then(([
            {Island},
            {MediaSource},
            {OsdSource},
            {BatterySource},
            {BluetoothSource},
            {NotificationSource},
            {RecordingSource},
            {ProgressSource},
            {SystemControls},
            {SystemStats},
            {FileShelfBridge},
        ]) => {
            if (!this._enabled)
                return;
            const SOURCES = [
                MediaSource,
                OsdSource,
                BatterySource,
                BluetoothSource,
                NotificationSource,
                RecordingSource,
                ProgressSource,
            ];
            this._island = new Island(this._settings, {SystemControls, SystemStats, FileShelfBridge});
            this._sources = SOURCES.map(Source => new Source(this._island, this._settings));
        }).catch(e => {
            console.error(`Dynamic Island load error: ${e}`);
        });
    }

    disable() {
        this._enabled = false;
        this._sources?.forEach(source => source.destroy());
        this._sources = null;
        this._island?.destroy();
        this._island = null;
        this._settings = null;
    }
}
