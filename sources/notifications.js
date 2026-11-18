import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class NotificationSource {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._trackedSources = new Map();
        this._origShowNotification = null;

        this._trayAddedId = Main.messageTray.connect('source-added', (tray, source) => this._bindSource(source));
        Main.messageTray.getSources?.().forEach(s => this._bindSource(s));

        this._settingsIds = [
            this._settings.connect('changed::show-notifications', () => this._syncBannerSuppression()),
            this._settings.connect('changed::suppress-gnome-notification-banner', () => this._syncBannerSuppression()),
        ];
        this._syncBannerSuppression();
    }

    _syncBannerSuppression() {
        if (!this._settings)
            return;
        const shouldSuppress = this._settings.get_boolean('show-notifications') &&
            this._settings.get_boolean('suppress-gnome-notification-banner');
        const tray = Main.messageTray;
        if (!tray)
            return;

        if (shouldSuppress && !this._origShowNotification) {
            this._origShowNotification = tray._showNotification;
            tray._showNotification = () => {
                const n = tray._notificationQueue?.shift();
                if (n) {
                    n.acknowledged = true;
                    tray.emit?.('queue-changed');
                }
            };
            if (tray._banner)
                tray._hideNotification?.(false);
        } else if (!shouldSuppress && this._origShowNotification) {
            tray._showNotification = this._origShowNotification;
            this._origShowNotification = null;
        }
    }

    _bindSource(source) {
        if (!source || this._trackedSources.has(source))
            return;
        const addedId = source.connect('notification-added', (src, notification) => {
            this._onNotification(src, notification);
        });
        const destroyId = source.connect('destroy', () => {
            this._trackedSources.delete(source);
        });
        this._trackedSources.set(source, [addedId, destroyId]);
    }

    _onNotification(source, notification) {
        if (!this._island || !this._settings?.get_boolean('show-notifications'))
            return;
        const title = notification.title || source.title || 'Notifica';
        const bodyText = notification.body?.replace(/\n+/g, ' ') || '';
        const body = bodyText ? ` — ${bodyText}` : '';
        const icon = notification.gicon || source.icon || 'preferences-system-notifications-symbolic';

        const onActivate = () => {
            try {
                notification.activate();
            } catch (e) {
                // Ignore if already dismissed
            }
        };

        this._island.showNotification({
            title,
            body: bodyText,
            sourceName: source.title || '',
            icon,
            onActivate,
        });

        this._island.toast(icon, `${title}${body}`, {
            color: '#5e5ce6',
            duration: 3800,
            placementGroup: 'alert',
            subtitle: bodyText || source.title || '',
            titleText: title,
            onActivate,
        });
    }

    destroy() {
        const tray = Main.messageTray;
        if (tray && this._origShowNotification) {
            tray._showNotification = this._origShowNotification;
            this._origShowNotification = null;
        }
        if (this._trayAddedId && tray) {
            tray.disconnect(this._trayAddedId);
            this._trayAddedId = 0;
        }
        if (this._settingsIds && this._settings) {
            this._settingsIds.forEach(id => this._settings.disconnect(id));
            this._settingsIds = null;
        }
        for (const [src, ids] of this._trackedSources.entries()) {
            ids.forEach(id => {
                try {
                    src.disconnect(id);
                } catch (e) {
                    // Ignore if source already destroyed
                }
            });
        }
        this._trackedSources.clear();
        this._island = null;
        this._settings = null;
    }
}
