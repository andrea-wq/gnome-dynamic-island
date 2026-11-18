import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {MprisPlayer} from 'resource:///org/gnome/shell/ui/mpris.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

const findApp = name => {
    const id = name && Shell.AppSystem.search(name)[0]?.[0];
    return id ? Shell.AppSystem.get_default().lookup_app(id) : null;
};

function getPlayerStatus(player) {
    return player?._playerProxy ? player.status : 'Stopped';
}

function sourceOf(player) {
    const identity = player._mprisProxy?.Identity ?? '';
    const app = player.app ?? findApp(identity);
    const url = player._playerProxy?.Metadata?.['xesam:url']?.deepUnpack() ?? '';
    return {
        name: /youtube\.com|youtu\.be/.test(url) ? 'YouTube' : app?.get_name() ?? identity,
        icon: app?.get_icon() ?? 'audio-x-generic-symbolic',
    };
}

export class MediaSource {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._players = new Map();
        this._current = null;

        this._settings.connectObject('changed::show-media', () => this._update(), this);

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null, (connection, res) => {
                try {
                    const [names] = connection.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    // Ignore if destroyed before reply
                }
            });

        this._nameOwnerSub = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (connection, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (newOwner && !oldOwner)
                    this._addPlayer(name);
                else if (oldOwner && !newOwner)
                    this._removePlayer(name);
            });
    }

    destroy() {
        this._settings?.disconnectObject(this);
        if (this._nameOwnerSub) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerSub);
            this._nameOwnerSub = 0;
        }
        if (this._players) {
            for (const {player, changedId} of this._players.values())
                player.disconnect(changedId);
        }
        this._players = null;
        this._current = null;
        this._island = null;
        this._settings = null;
    }

    _update() {
        if (!this._island)
            return;
        if (!this._settings.get_boolean('show-media')) {
            this._island.setPlayer(null, null);
            return;
        }
        if (this._current && !this._current._playerProxy) {
            const rest = [...(this._players?.values() ?? [])].map(e => e.player).filter(p => p._playerProxy);
            this._current = rest.find(p => getPlayerStatus(p) === 'Playing') ?? rest[0] ?? null;
        }
        this._island.setPlayer(this._current, this._current && sourceOf(this._current));
    }

    _addPlayer(busName) {
        if (!this._players || this._players.has(busName))
            return;
        const player = new MprisPlayer(busName);
        const changedId = player.connect('changed', () => {
            if (!player._playerProxy) {
                this._removePlayer(busName);
                return;
            }
            if (getPlayerStatus(player) === 'Playing' || !this._current)
                this._current = player;
            this._update();
        });
        this._players.set(busName, {player, changedId});
    }

    _removePlayer(busName) {
        if (!this._players)
            return;
        const entry = this._players.get(busName);
        if (entry) {
            entry.player.disconnect(entry.changedId);
            this._players.delete(busName);
        }
        if (this._current === entry?.player || !this._current?._playerProxy) {
            const rest = [...this._players.values()].map(e => e.player).filter(p => p._playerProxy);
            this._current = rest.find(p => getPlayerStatus(p) === 'Playing') ?? rest[0] ?? null;
        }
        this._update();
    }
}
