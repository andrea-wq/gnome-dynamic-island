import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth';
import NM from 'gi://NM';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const PROFILE_LABELS = {
    'performance': ['Prestazioni', 'power-profile-performance-symbolic'],
    'balanced': ['Bilanciato', 'power-profile-balanced-symbolic'],
    'power-saver': ['Risparmio', 'power-profile-power-saver-symbolic'],
};

const decoder = new TextDecoder('utf-8');

export class SystemControls {
    constructor(onChange) {
        this._onChange = onChange;
        this._cancellable = new Gio.Cancellable();
        this._stream = null;
        this._nmClient = null;
        this._wifiDev = null;
        this._btClient = null;
        this._btStore = null;
        this._btDevices = [];
        this._upowerProxy = null;
        this._ppProxy = null;
        this._origQsSourceActor = null;
        this._emitTimeoutId = 0;

        // 1. Volume (Gvc.MixerControl)
        try {
            this._mixer = Volume.getMixerControl();
            this._mixer.connectObject(
                'default-sink-changed', () => this._bindSink(),
                'state-changed', () => this._bindSink(),
                this
            );
            this._bindSink();
        } catch (e) {
            console.warn(`Dynamic Island: mixer unavailable: ${e.message}`);
        }

        // 2. Brightness (Main.brightnessManager)
        this._brightnessManager = Main.brightnessManager;
        this._brightnessScale = null;
        if (this._brightnessManager) {
            this._brightnessManager.connectObject('changed', () => this._bindBrightness(), this);
            this._bindBrightness();
        }

        // 3. Night Light & Do Not Disturb (GSettings)
        try {
            this._colorSettings = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
            this._colorSettings.connectObject('changed::night-light-enabled', () => this._emit(), this);
        } catch (e) {
            this._colorSettings = null;
        }

        try {
            this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            this._notifSettings.connectObject('changed::show-banners', () => this._emit(), this);
        } catch (e) {
            this._notifSettings = null;
        }

        // 4. UPower DisplayDevice
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device',
            this._cancellable,
            (src, res) => {
                try {
                    this._upowerProxy = Gio.DBusProxy.new_for_bus_finish(res);
                    this._upowerProxy.connectObject('g-properties-changed', () => this._emit(), this);
                    this._emit();
                } catch (e) {
                    // Ignore
                }
            }
        );

        // 5. Power Profiles
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            'org.freedesktop.UPower.PowerProfiles',
            '/org/freedesktop/UPower/PowerProfiles',
            'org.freedesktop.UPower.PowerProfiles',
            this._cancellable,
            (src, res) => {
                try {
                    this._ppProxy = Gio.DBusProxy.new_for_bus_finish(res);
                    this._ppProxy.connectObject('g-properties-changed', () => this._emit(), this);
                    this._emit();
                } catch (e) {
                    // Ignore
                }
            }
        );

        // 6. NetworkManager Client (Wi-Fi state, SSID, access points)
        NM.Client.new_async(this._cancellable, (obj, res) => {
            try {
                this._nmClient = NM.Client.new_finish(res);
                this._nmClient.connectObject(
                    'notify::wireless-enabled', () => this._emit(),
                    'notify::primary-connection', () => this._emit(),
                    'notify::activating-connection', () => this._emit(),
                    'notify::state', () => this._emit(),
                    'device-added', () => this._bindWifiDevice(),
                    'device-removed', () => this._bindWifiDevice(),
                    this
                );
                this._bindWifiDevice();
                this._emit();
            } catch (e) {
                // Ignore
            }
        });

        // 7. GnomeBluetooth Client (Adapter power & devices)
        try {
            this._btClient = new GnomeBluetooth.Client();
            this._btClient.connectObject(
                'notify::default-adapter', () => this._emit(),
                'notify::default-adapter-powered', () => this._emit(),
                'notify::default-adapter-state', () => this._emit(),
                this
            );
            this._btStore = this._btClient.get_devices();
            this._btStore.connectObject('items-changed', () => this._bindBtDevices(), this);
            this._bindBtDevices();
        } catch (e) {
            this._btClient = null;
        }
    }

    _emit() {
        if (this._emitTimeoutId || !this._onChange)
            return;
        this._emitTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 35, () => {
            this._emitTimeoutId = 0;
            this._onChange?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    _bindSink() {
        this._stream?.disconnectObject(this);
        this._stream = this._mixer?.get_default_sink() ?? null;
        if (this._stream) {
            this._stream.connectObject(
                'notify::volume', () => this._emit(),
                'notify::is-muted', () => this._emit(),
                this
            );
        }
        this._emit();
    }

    _bindBrightness() {
        this._brightnessScale?.disconnectObject(this);
        this._brightnessScale = this._brightnessManager?.globalScale ?? null;
        if (this._brightnessScale)
            this._brightnessScale.connectObject('notify::value', () => this._emit(), this);
        this._emit();
    }

    _bindWifiDevice() {
        this._wifiDev?.disconnectObject(this);
        this._wifiDev = null;
        if (!this._nmClient)
            return;
        for (const dev of this._nmClient.get_devices()) {
            if (dev.get_device_type() === NM.DeviceType.WIFI) {
                this._wifiDev = dev;
                this._wifiDev.connectObject(
                    'notify::active-access-point', () => this._emit(),
                    'access-point-added', () => this._emit(),
                    'access-point-removed', () => this._emit(),
                    this
                );
                break;
            }
        }
        this._emit();
    }

    _bindBtDevices() {
        this._btDevices.forEach(d => d.disconnectObject(this));
        this._btDevices = [];
        if (!this._btStore)
            return;
        for (let i = 0; i < this._btStore.get_n_items(); i++) {
            const dev = this._btStore.get_item(i);
            dev.connectObject(
                'notify::connected', () => this._emit(),
                'notify::battery-percentage', () => this._emit(),
                this
            );
            this._btDevices.push(dev);
        }
        this._emit();
    }

    // --- VOLUME ---
    getVolumeState() {
        if (!this._stream || !this._mixer)
            return {volume: 0, muted: true, icon: 'audio-volume-muted-symbolic'};
        const max = this._mixer.get_vol_max_norm();
        const muted = this._stream.is_muted;
        const vol = max > 0 ? Math.max(0, Math.min(1, this._stream.volume / max)) : 0;
        let icon = 'audio-volume-high-symbolic';
        if (muted || vol === 0)
            icon = 'audio-volume-muted-symbolic';
        else if (vol < 0.34)
            icon = 'audio-volume-low-symbolic';
        else if (vol < 0.67)
            icon = 'audio-volume-medium-symbolic';
        return {volume: vol, muted, icon};
    }

    setVolume(fraction) {
        if (!this._stream || !this._mixer)
            return;
        const max = this._mixer.get_vol_max_norm();
        const clamped = Math.max(0, Math.min(1, fraction));
        this._stream.volume = Math.round(clamped * max);
        this._stream.push_volume();
        if (clamped > 0 && this._stream.is_muted)
            this._stream.change_is_muted(false);
    }

    toggleMute() {
        if (!this._stream)
            return;
        this._stream.change_is_muted(!this._stream.is_muted);
    }

    // --- BRIGHTNESS ---
    getBrightnessState() {
        if (!this._brightnessScale)
            return {available: false, value: 1};
        return {
            available: true,
            value: Math.max(0, Math.min(1, this._brightnessScale.value ?? 1)),
        };
    }

    setBrightness(fraction) {
        if (!this._brightnessScale)
            return;
        this._brightnessScale.value = Math.max(0.02, Math.min(1, fraction));
    }

    // --- BATTERY ---
    getBatteryState() {
        if (!this._upowerProxy)
            return {present: false, percent: 100, icon: 'battery-full-symbolic'};
        const isPresent = this._upowerProxy.get_cached_property('IsPresent')?.unpack() ?? true;
        const percent = Math.round(this._upowerProxy.get_cached_property('Percentage')?.unpack() ?? 100);
        const icon = this._upowerProxy.get_cached_property('IconName')?.unpack() || 'battery-good-symbolic';
        return {present: isPresent, percent, icon};
    }

    // --- WI-FI / NETWORK ---
    getNetworkState() {
        if (!this._nmClient)
            return {enabled: true, label: 'Wi-Fi', sub: 'Attivo', icon: 'network-wireless-signal-good-symbolic'};
        const wifiEnabled = this._nmClient.wireless_enabled;
        const primary = this._nmClient.primary_connection;
        if (!wifiEnabled) {
            return {
                enabled: false,
                label: 'Wi-Fi',
                sub: 'Disattivato',
                icon: 'network-wireless-disabled-symbolic',
            };
        }
        if (primary) {
            const id = primary.get_id() || 'Connesso';
            const type = primary.get_connection_type();
            const isWired = type?.includes('ethernet');
            return {
                enabled: true,
                label: isWired ? 'Ethernet' : 'Wi-Fi',
                sub: id,
                icon: isWired ? 'network-wired-symbolic' : 'network-wireless-signal-excellent-symbolic',
            };
        }
        return {
            enabled: true,
            label: 'Wi-Fi',
            sub: 'Non connesso',
            icon: 'network-wireless-acquiring-symbolic',
        };
    }

    setWifiEnabled(enabled) {
        if (!this._nmClient)
            return;
        this._nmClient.wireless_enabled = !!enabled;
    }

    scanWifi() {
        try {
            this._wifiDev?.request_scan_async(this._cancellable, null);
        } catch (e) {
            // Ignore scan rate-limit errors
        }
    }

    getWifiNetworks() {
        if (!this._nmClient || !this._wifiDev || !this._nmClient.wireless_enabled)
            return [];

        const activeAp = this._wifiDev.get_active_access_point();
        const activeSsid = activeAp?.get_ssid() ? decoder.decode(activeAp.get_ssid().get_data()) : null;

        const savedSsids = new Set();
        for (const conn of this._nmClient.get_connections()) {
            const sWireless = conn.get_setting_wireless();
            if (sWireless) {
                const raw = sWireless.get_ssid()?.get_data();
                if (raw)
                    savedSsids.add(decoder.decode(raw));
            }
        }

        const bySsid = new Map();
        for (const ap of this._wifiDev.get_access_points()) {
            const ssidBytes = ap.get_ssid()?.get_data();
            if (!ssidBytes || ssidBytes.length === 0)
                continue;
            const ssid = decoder.decode(ssidBytes);
            const strength = ap.get_strength();
            const isActive = activeSsid === ssid && ap.get_path() === activeAp?.get_path();
            const secured = (ap.get_flags() !== 0) || (ap.get_wpa_flags() !== 0) || (ap.get_rsn_flags() !== 0);

            const prev = bySsid.get(ssid);
            if (!prev || isActive || (!prev.active && strength > prev.strength)) {
                bySsid.set(ssid, {
                    ssid,
                    strength,
                    active: activeSsid === ssid,
                    secured,
                    saved: savedSsids.has(ssid),
                    apPath: ap.get_path(),
                });
            }
        }

        return [...bySsid.values()].sort((a, b) => {
            if (a.active !== b.active)
                return a.active ? -1 : 1;
            if (a.saved !== b.saved)
                return a.saved ? -1 : 1;
            return b.strength - a.strength;
        });
    }

    connectWifi(ssid, apPath, password = null, onDone = null) {
        if (!this._nmClient || !this._wifiDev)
            return {started: false, needsPassword: false};

        // 1. Check for existing saved connection
        for (const conn of this._nmClient.get_connections()) {
            const sWireless = conn.get_setting_wireless();
            const raw = sWireless?.get_ssid()?.get_data();
            if (raw && decoder.decode(raw) === ssid) {
                this._nmClient.activate_connection_async(conn, this._wifiDev, apPath, null, (c, res) => {
                    try {
                        c.activate_connection_finish(res);
                        onDone?.(true);
                    } catch (e) {
                        onDone?.(false, e.message);
                    }
                });
                return {started: true, needsPassword: false};
            }
        }

        // 2. Check if network is secured and no password provided yet
        const ap = this._wifiDev.get_access_points().find(a => a.get_path() === apPath);
        const secured = ap && ((ap.get_flags() !== 0) || (ap.get_wpa_flags() !== 0) || (ap.get_rsn_flags() !== 0));
        if (secured && !password)
            return {started: false, needsPassword: true};

        // 3. Create new connection and activate
        const conn = new NM.SimpleConnection();
        const sConn = new NM.SettingConnection({
            id: ssid,
            type: '802-11-wireless',
            uuid: NM.utils_uuid_generate(),
        });
        const sWifi = new NM.SettingWireless({
            ssid: GLib.Bytes.new(new TextEncoder().encode(ssid)),
            mode: 'infrastructure',
        });
        conn.add_setting(sConn);
        conn.add_setting(sWifi);

        if (secured && password) {
            const sSec = new NM.SettingWirelessSecurity({
                key_mgmt: 'wpa-psk',
                psk: password,
            });
            conn.add_setting(sSec);
        }

        this._nmClient.add_and_activate_connection_async(conn, this._wifiDev, apPath, null, (c, res) => {
            try {
                c.add_and_activate_connection_finish(res);
                onDone?.(true);
            } catch (e) {
                onDone?.(false, e.message);
            }
        });
        return {started: true, needsPassword: false};
    }

    // --- BLUETOOTH ---
    getBluetoothState() {
        if (!this._btClient)
            return {available: false, powered: false, connectedCount: 0, sub: 'Non disponibile'};
        const powered = !!this._btClient.default_adapter_powered;
        const connected = this._btDevices.filter(d => d.connected);
        let sub = powered ? 'Attivo' : 'Disattivato';
        if (powered && connected.length === 1)
            sub = connected[0].alias || '1 dispositivo';
        else if (powered && connected.length > 1)
            sub = `${connected.length} connessi`;
        return {
            available: true,
            powered,
            connectedCount: connected.length,
            sub,
        };
    }

    setBluetoothPowered(powered) {
        if (!this._btClient)
            return;
        this._btClient.default_adapter_powered = !!powered;
    }

    getBluetoothDevices() {
        if (!this._btClient)
            return [];
        return this._btDevices
            .filter(d => d.paired || d.connected)
            .map(d => ({
                path: d.get_object_path(),
                name: d.alias || d.name || 'Dispositivo',
                icon: d.icon ? `${d.icon}-symbolic` : 'bluetooth-active-symbolic',
                connected: !!d.connected,
                battery: d.battery_percentage > 0 ? Math.round(d.battery_percentage) : null,
            }))
            .sort((a, b) => (a.connected === b.connected ? a.name.localeCompare(b.name) : (a.connected ? -1 : 1)));
    }

    toggleBluetoothDevice(objectPath, connect, onDone = null) {
        if (!this._btClient)
            return;
        this._btClient.connect_service(objectPath, connect, this._cancellable, (client, res) => {
            try {
                const ok = client.connect_service_finish(res);
                onDone?.(ok);
            } catch (e) {
                onDone?.(false);
            }
        });
    }

    // --- NIGHT LIGHT ---
    getNightLight() {
        return this._colorSettings?.get_boolean('night-light-enabled') ?? false;
    }

    toggleNightLight() {
        if (!this._colorSettings)
            return;
        this._colorSettings.set_boolean('night-light-enabled', !this.getNightLight());
    }

    // --- DO NOT DISTURB ---
    getDnd() {
        return !(this._notifSettings?.get_boolean('show-banners') ?? true);
    }

    toggleDnd() {
        if (!this._notifSettings)
            return;
        const currentBanners = this._notifSettings.get_boolean('show-banners');
        this._notifSettings.set_boolean('show-banners', !currentBanners);
    }

    // --- POWER PROFILES ---
    getPowerProfile() {
        const active = this._ppProxy?.get_cached_property('ActiveProfile')?.unpack() || 'balanced';
        const [label, icon] = PROFILE_LABELS[active] ?? PROFILE_LABELS.balanced;
        return {id: active, label, icon};
    }

    cyclePowerProfile() {
        if (!this._ppProxy)
            return;
        const order = ['power-saver', 'balanced', 'performance'];
        const cur = this.getPowerProfile().id;
        const next = order[(order.indexOf(cur) + 1) % order.length];
        this._ppProxy.call(
            'org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [
                'org.freedesktop.UPower.PowerProfiles',
                'ActiveProfile',
                new GLib.Variant('s', next),
            ]),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
    }

    // --- SYSTEM ACTIONS ---
    openGnomeSettings(panel = null) {
        try {
            if (panel) {
                GLib.spawn_command_line_async(`gnome-control-center ${panel}`);
            } else {
                const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Settings.desktop');
                if (app)
                    app.activate();
                else
                    GLib.spawn_command_line_async('gnome-control-center');
            }
        } catch (e) {
            // Ignore launch error
        }
    }

    openNativeQuickSettings(anchorActor) {
        const qs = Main.panel.statusArea.quickSettings;
        if (!qs?.menu)
            return;
        if (!this._origQsSourceActor)
            this._origQsSourceActor = qs.menu.sourceActor;
        if (!Main.layoutManager.panelBox.visible && anchorActor)
            qs.menu.sourceActor = anchorActor;
        else if (this._origQsSourceActor)
            qs.menu.sourceActor = this._origQsSourceActor;
        qs.menu.toggle();
    }

    takeScreenshot() {
        Main.screenshotUI?.open();
    }

    lockScreen() {
        try {
            SystemActions.getDefault().activateLockScreen();
        } catch (e) {
            Main.screenShield?.lock(true);
        }
    }

    suspend() {
        try {
            SystemActions.getDefault().activateSuspend();
        } catch (e) {
            // Ignore
        }
    }

    restart() {
        try {
            SystemActions.getDefault().activateRestart();
        } catch (e) {
            // Ignore
        }
    }

    powerOff() {
        try {
            SystemActions.getDefault().activatePowerOff();
        } catch (e) {
            // Ignore
        }
    }

    destroy() {
        if (this._emitTimeoutId) {
            GLib.source_remove(this._emitTimeoutId);
            this._emitTimeoutId = 0;
        }
        this._cancellable.cancel();
        this._mixer?.disconnectObject(this);
        this._stream?.disconnectObject(this);
        this._brightnessManager?.disconnectObject(this);
        this._brightnessScale?.disconnectObject(this);
        this._colorSettings?.disconnectObject(this);
        this._notifSettings?.disconnectObject(this);
        this._upowerProxy?.disconnectObject(this);
        this._ppProxy?.disconnectObject(this);
        this._nmClient?.disconnectObject(this);
        this._wifiDev?.disconnectObject(this);
        this._btClient?.disconnectObject(this);
        this._btStore?.disconnectObject(this);
        this._btDevices.forEach(d => d.disconnectObject(this));
        this._btDevices = [];
        const qs = Main.panel.statusArea.quickSettings;
        if (qs?.menu && this._origQsSourceActor)
            qs.menu.sourceActor = this._origQsSourceActor;
        this._onChange = null;
    }
}
