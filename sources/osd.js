import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class OsdSource {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._originalShow = null;
        this._settings.connectObject('changed::show-volume', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        if (this._settings.get_boolean('show-volume'))
            this._patch();
        else
            this._unpatch();
    }

    _patch() {
        if (this._originalShow)
            return;
        const osd = Main.osdWindowManager;
        const originalShow = osd.show;
        this._originalShow = originalShow;
        osd.show = (...args) => {
            try {
                const [, icon, label, level] = args;
                if (typeof icon !== 'string' && !(icon instanceof Gio.Icon))
                    throw new Error(`unexpected icon ${icon}`);
                const hasLevel = Number.isFinite(level);
                const pct = hasLevel ? `${Math.round(Math.max(0, Math.min(level, 1)) * 100)}%` : String(label ?? '');
                this._island.toast(icon, pct, {level: hasLevel ? level : null, duration: 1600});
            } catch (e) {
                console.warn(`Dynamic Island: OSD fallback to shell OSD: ${e}`);
                originalShow.apply(osd, args);
            }
        };
    }

    _unpatch() {
        if (!this._originalShow)
            return;
        Main.osdWindowManager.show = this._originalShow;
        this._originalShow = null;
    }

    destroy() {
        this._settings?.disconnectObject(this);
        this._unpatch();
        this._island = null;
        this._settings = null;
    }
}
