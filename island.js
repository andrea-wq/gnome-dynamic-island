import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {SystemControls as DefaultSystemControls} from './sources/systemControls.js';
import {SystemStats as DefaultSystemStats} from './sources/systemStats.js';

const MODULE_QUERY = (() => {
    const idx = import.meta.url.indexOf('?');
    return idx >= 0 ? import.meta.url.slice(idx) : '';
})();

const BAR_W = 160;
const SPACING = 10;

const ART_RADIUS = {
    circle: size => size / 2,
    rounded: size => size / 4,
    square: () => 4,
};

const ART_BORDER = {
    subtle: () => '1px solid rgba(255,255,255,0.28)',
    white: () => '2px solid #ffffff',
    accent: settings => `2px solid ${settings.get_string('accent-color')}`,
};

const PANEL_SLOTS = {
    'panel-notch': ['_centerBox', 0, null],
    'panel-center': ['_centerBox', 0, 0.5],
    'panel-left': ['_leftBox', -1, 0],
    'panel-right': ['_rightBox', 0, 1],
};

const ANIM_PROFILES = {
    snappy: {duration: 240, mode: Clutter.AnimationMode.EASE_OUT_EXPO},
    spring: {duration: 350, mode: Clutter.AnimationMode.EASE_OUT_BACK},
    smooth: {duration: 270, mode: Clutter.AnimationMode.EASE_OUT_CUBIC},
    instant: {duration: 0, mode: Clutter.AnimationMode.LINEAR},
};

const lerp = (a, b, p) => a + (b - a) * p;

const EQ_WIDTH = {bars: 22, spectrum: 30, segments: 24, solid: 30, wave: 30, ribbon: 30};
const EQ_HEIGHT = 18;
const EQ_LEVELS = 8;

function accentGradient(hex) {
    const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#ff6a00';
    const rgb = [1, 3, 5].map(i => parseInt(clean.slice(i, i + 2), 16) / 255);
    const [r, g, b] = rgb;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    const h = !d ? 0 : max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const hue = (h * 60 + 15 + 360) % 360, light = Math.min(l + 0.14, 0.9);
    const a = s * Math.min(light, 1 - light);
    const k = n => (n + hue / 30) % 12;
    return [[0, 8, 4].map(n => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))), rgb];
}

function roundedRect(cr, x, y, w, h, radius = Math.min(w, h) / 2) {
    const r = Math.min(radius, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

const toGicon = icon => typeof icon === 'string' ? new Gio.ThemedIcon({name: icon}) : icon;

function formatTimer(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildLayouts(settings) {
    const tighten = Math.max(0, -settings.get_int('width'));
    const shape = settings.get_string('art-shape');
    const radius = (size, auto) => (ART_RADIUS[shape] ?? auto)(size);
    const small = settings.get_int('art-size');
    const big = settings.get_int('art-size-expanded');
    const panelPad = Math.max(2, 4 - Math.floor((small - 24) / 2));
    const artRadius = radius(small, ART_RADIUS.circle);
    const compact = {
        radius: Math.max(15, Math.round(small / 2 + 6)),
        padding: [5, Math.max(6, 12 - tighten), 5, 8],
        spacing: Math.max(4, SPACING - tighten),
        artSize: small,
        artRadius,
        expanded: false,
    };
    const expanded = {
        radius: 24,
        padding: [12, 16, 14, 16],
        spacing: SPACING,
        artSize: big,
        artRadius: radius(big, ART_RADIUS.rounded),
        expanded: true,
    };
    return {
        compact,
        compactNotch: {...compact, topRadius: 0},
        panelCompact: {...compact, padding: [panelPad, Math.max(6, 10 - tighten), panelPad, 6]},
        slimClock: {
            radius: 10,
            topRadius: 9,
            padding: [1, 8, 2, 8],
            spacing: 4,
            artSize: small,
            artRadius,
            expanded: false,
            dodged: true,
        },
        slimClockNotch: {
            radius: 10,
            topRadius: 0,
            padding: [1, 8, 2, 8],
            spacing: 4,
            artSize: small,
            artRadius,
            expanded: false,
            dodged: true,
        },
        peekBar: {
            radius: 7,
            topRadius: 7,
            padding: [2, 10, 3, 10],
            spacing: 4,
            artSize: small,
            artRadius,
            expanded: false,
            dodged: true,
        },
        peekBarNotch: {
            radius: 7,
            topRadius: 0,
            padding: [2, 10, 3, 10],
            spacing: 4,
            artSize: small,
            artRadius,
            expanded: false,
            dodged: true,
        },
        expanded,
        expandedTopNotch: {...expanded, padding: [0, expanded.padding[1], expanded.padding[2], expanded.padding[3]], topRadius: 0},
    };
}

export const Island = GObject.registerClass({
    GTypeName: `DynamicIslandNotch_${GLib.get_monotonic_time()}`,
}, class Island extends St.BoxLayout {
    _init(settings, deps = {}) {
        super._init({
            style_class: 'di-island',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            visible: false,
            clip_to_allocation: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });

        const SystemControlsClass = deps.SystemControls || DefaultSystemControls;
        const SystemStatsClass = deps.SystemStats || DefaultSystemStats;

        this._settings = settings;
        this._player = null;
        this._hasMusic = false;
        this._expanded = false;
        this._shown = false;
        this._trackKey = null;
        this._indicators = new Map();
        this._toastActive = false;
        this._toastId = 0;
        this._hoverId = 0;
        this._hoverWatchId = 0;
        this._outsideTicks = 0;
        this._expandTimestamp = 0;
        this._morphing = false;
        this._unredirectDisabled = false;
        this._layouts = buildLayouts(settings);
        this._layout = this._layouts.compact;
        this._geometry = this._layout;
        this._slot = null;
        this._position = null;
        this._restWidth = 0;
        this._lastMainStyle = '';
        this._artBackground = '';
        this._artCancellable = new Gio.Cancellable();
        this._levels = new Array(EQ_LEVELS).fill(0);
        this._targets = new Array(EQ_LEVELS).fill(0);
        this._phase = 0;
        this._eqId = 0;
        this._eqRunning = false;
        this._eqGrad = null;
        this._eqGradKey = '';
        this._accent = accentGradient(settings.get_string('accent-color'));
        this._activeTab = 'media';
        this._systemSubView = null; // null | 'wifi' | 'bluetooth'
        this._pendingWifi = null;
        this._wifiBusySsid = null;
        this._btBusyPath = null;
        this._notifications = [];
        this._shelfFiles = [];
        this._dragOpening = false;
        this._syncingSliders = false;
        this._sysControlsDirty = true;
        this._lastWsKey = '';
        this._topCovered = false;
        this._focusedWin = null;
        this._dodgeCheckId = 0;
        this._belowToast = null;
        this._belowToastId = 0;
        this._belowToastAction = null;
        this._mediaLengthUs = 0;
        this._mediaPosUs = 0;
        this._mediaTrackId = null;
        this._mediaCanSeek = false;
        this._mediaPosId = 0;
        this._mediaDragging = false;
        this._syncingMediaSlider = false;
        this._mediaSeekCommitId = 0;

        // Prevent Mutter KMS Direct Scanout from bypassing the Clutter stage when a window covers 0,0,1920x1080
        try {
            global.compositor.disable_unredirect();
            this._unredirectDisabled = true;
        } catch (e) {
            // Ignore if unavailable
        }

        // Timer state
        this._timerRemaining = 25 * 60;
        this._timerRunning = false;
        this._timerTickId = 0;

        // Clock & System stats timers
        this._idleClockId = 0;
        this._hubStatsId = 0;
        this._lastMinuteStr = '';
        this._sysStats = new SystemStatsClass();

        // Build Compact Bar & Expanded Container
        this._buildCompactBar();
        this._buildExpandedView();

        // System Controls
        this._sysControls = new SystemControlsClass(() => this._syncSystemControlsUI());

        // File Shelf Drag & Drop Bridge (dynamically imported with cache-buster query for hot-reload)
        this._fileShelf = null;
        const initFileShelf = FileShelfBridgeClass => {
            if (this._destroyed)
                return;
            this._fileShelf = new FileShelfBridgeClass({
                hitTest: (px, py) => {
                    if (!this.visible)
                        return false;
                    const [ax, ay] = this.get_transformed_position();
                    const [aw, ah] = this.get_transformed_size();
                    const pad = 28;
                    return px >= ax - pad && px <= ax + aw + pad &&
                           py >= Math.max(0, ay - pad) && py <= ay + ah + pad;
                },
                onArm: () => {
                    this._dragOpening = true;
                    this._switchTab('file', false);
                    this._dropZone?.add_style_class_name('di-drop-zone-tall');
                    if (this._shelfScroll)
                        this._shelfScroll.visible = false;
                    this._setExpanded(true);
                },
                targetRect: () => {
                    const [ax, ay] = this.get_transformed_position();
                    const [aw, ah] = this.get_transformed_size();
                    return {
                        x: Math.round(this._targetX ?? ax),
                        y: Math.round(this._targetY ?? ay),
                        width: Math.max(490, Math.round(this._targetW ?? aw)),
                        height: Math.max(230, Math.round(this._targetH ?? ah)),
                    };
                },
                setPassThrough: on => {
                    const stack = [this];
                    while (stack.length > 0) {
                        const actor = stack.pop();
                        if (on) {
                            if (actor.reactive) {
                                actor._diDropRestore = true;
                                actor.reactive = false;
                            }
                        } else if (actor._diDropRestore) {
                            delete actor._diDropRestore;
                            actor.reactive = true;
                        }
                        for (const child of actor.get_children())
                            stack.push(child);
                    }
                },
                onOver: inside => {
                    if (!this._dropZone)
                        return;
                    if (inside) {
                        this._dropZone.add_style_class_name('di-drop-zone-active');
                        this._dropZoneLabel.text = 'Rilascia ora per salvare nella mensola';
                    } else {
                        this._dropZone.remove_style_class_name('di-drop-zone-active');
                        this._dropZoneLabel.text = 'Trascina qui immagini o file';
                    }
                },
                onDropPending: () => {
                    if (this._dropZoneLabel)
                        this._dropZoneLabel.text = 'Salvataggio immagine…';
                },
                onFiles: uris => this.addShelfFiles(uris),
                onDragEnd: dropped => {
                    this._dragOpening = false;
                    if (this._dropZone) {
                        this._dropZone.remove_style_class_name('di-drop-zone-active');
                        this._dropZone.remove_style_class_name('di-drop-zone-tall');
                        this._dropZoneLabel.text = 'Trascina qui immagini o file';
                    }
                    if (this._shelfScroll)
                        this._shelfScroll.visible = this._shelfFiles.length > 0;
                    this._refresh();
                    if (!dropped && !this._isPointerInside())
                        this._setExpanded(false);
                },
                onRemoveUri: uri => {
                    this._shelfFiles = this._shelfFiles.filter(f => f.uri !== uri);
                    this._rebuildShelfUI();
                    this._refresh();
                },
                onTrayDragEnd: () => {
                    this._syncShelfTrayVisibility();
                },
                onOpenUri: uri => {
                    try {
                        Gio.AppInfo.launch_default_for_uri(uri, null);
                    } catch (e) {
                        // Ignore
                    }
                },
            });
            this._syncShelfTrayVisibility();
        };

        if (deps.FileShelfBridge) {
            initFileShelf(deps.FileShelfBridge);
        } else {
            import(`./sources/fileShelf.js${MODULE_QUERY}`)
                .then(({FileShelfBridge}) => initFileShelf(FileShelfBridge))
                .catch(e => console.warn(`Dynamic Island: FileShelf load error: ${e.message}`));
        }

        this._loadNotes();
        this._updateStaticStyles();
        this._syncTopBarVisibility();
        this._place();
        this._applyBoxStyle(this._compact());

        // Event & signal bindings
        this.connect('notify::hover', () => this._onHover());
        this.connect('enter-event', () => {
            this._outsideTicks = 0;
            this._onHover();
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('scroll-event', (actor, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.connectObject('monitors-changed', () => {
            this._reposition();
            this._scheduleDodgeCheck();
        }, this);
        global.display.connectObject(
            'in-fullscreen-changed', () => {
                this._raiseToTop();
                this._scheduleDodgeCheck();
            },
            'notify::focus-window', () => {
                this._raiseToTop();
                this._trackFocusedWindow();
                this._scheduleDodgeCheck();
            },
            'grab-op-end', () => this._scheduleDodgeCheck(),
            'window-entered-monitor', () => this._scheduleDodgeCheck(),
            'window-left-monitor', () => this._scheduleDodgeCheck(),
            this
        );
        global.window_manager.connectObject(
            'map', () => this._scheduleDodgeCheck(),
            'destroy', () => this._scheduleDodgeCheck(),
            'minimize', () => this._scheduleDodgeCheck(),
            'unminimize', () => this._scheduleDodgeCheck(),
            'switch-workspace', () => this._scheduleDodgeCheck(),
            this
        );
        Main.overview.connectObject(
            'showing', () => this._refresh(),
            'hidden', () => {
                this._scheduleDodgeCheck();
                this._refresh();
            },
            this
        );

        const wm = global.workspace_manager;
        wm.connectObject(
            'active-workspace-changed', () => {
                this._syncWorkspaces();
                this._scheduleDodgeCheck();
            },
            'notify::n-workspaces', () => this._syncWorkspaces(),
            this
        );

        settings.connectObject(
            'changed::position', () => {
                this._position = null;
                this._place();
                this._syncTopBarVisibility();
                this._scheduleDodgeCheck();
            },
            'changed::hide-top-bar', () => {
                this._position = null;
                this._syncTopBarVisibility();
                this._place();
                this._scheduleDodgeCheck();
            },
            'changed::show-compact-status', () => this._refresh(),
            'changed::hide-panel-clock', () => this._syncTopBarVisibility(),
            'changed::idle-mode', () => this._refresh(),
            'changed::auto-dodge', () => {
                this._checkAutoDodge();
                this._refresh();
            },
            'changed::toast-position', () => {
                if (this._settings.get_string('toast-position') !== 'below')
                    this._hideBelowToast(true);
            },
            'changed::show-workspaces', () => {
                this._syncWorkspaces();
                this._refresh();
            },
            'changed::eq-style', () => this._setEqStyle(),
            'changed::width', () => this._updateLayouts(),
            'changed::expanded-width', () => this._updateLayouts(),
            'changed::art-size', () => this._updateLayouts(),
            'changed::art-size-expanded', () => this._updateLayouts(),
            'changed::art-shape', () => this._updateLayouts(),
            'changed::art-border', () => this._updateStaticStyles(),
            'changed::art-compact', () => this._refresh(),
            'changed::art-spin', () => this._syncSpin(),
            'changed::text-width', () => {
                this._updateStaticStyles();
                this._refresh();
            },
            'changed::accent-color', () => {
                this._accent = accentGradient(settings.get_string('accent-color'));
                this._updateStaticStyles();
                if (this._eq.visible)
                    this._eq.queue_repaint();
            },
            'changed::quick-notes-json', () => this._loadNotes(),
            'changed::margin', () => this._reposition(),
            this
        );

        this._idleClockId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => this._tickIdleClock());
        this._syncWorkspaces();
        this._tickIdleClock();
        this._syncSystemControlsUI();
        this._trackFocusedWindow();
        this._checkAutoDodge();
        this._refresh();
        this._raiseToTop();
    }

    _raiseToTop() {
        if (!this._slot && this.get_parent() === Main.uiGroup)
            Main.uiGroup.set_child_above_sibling(this, null);
    }

    _getAnimProfile() {
        const reduced = St.Settings.get().reduced_motion === St.ReducedMotion?.REDUCE;
        if (reduced)
            return ANIM_PROFILES.instant;
        let style = 'snappy';
        try {
            style = this._settings.get_string('animation-style');
        } catch (e) {
            // Fallback
        }
        return ANIM_PROFILES[style] ?? ANIM_PROFILES.snappy;
    }

    _buildCompactBar() {
        this._compactRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
            style: 'spacing: 8px;',
        });
        this.add_child(this._compactRow);

        // 0. Auto-Dodge Peek Handle & Slim Music Dot
        this._dodgeBar = new St.Bin({
            style_class: 'di-dodge-bar',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactRow.add_child(this._dodgeBar);

        this._dodgeMusicDot = new St.Bin({
            style_class: 'di-dodge-music-dot',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactRow.add_child(this._dodgeMusicDot);

        // 1. Dynamic Workspace Pill
        this._wsButton = new St.Button({
            style_class: 'di-chip',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._wsBox = new St.BoxLayout({
            style_class: 'di-ws-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._wsButton.set_child(this._wsBox);
        this._wsButton.connect('clicked', () => Main.overview.toggle());
        this._compactRow.add_child(this._wsButton);

        // 2. Compact Idle Clock
        this._idleClockLabel = new St.Label({
            style_class: 'di-idle-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactRow.add_child(this._idleClockLabel);

        // 3. Notch gap around native clock when in panel-notch mode
        this._notch = new St.Widget({visible: false, x_expand: true});
        this._notch.connect('notify::x', () => this._reposition());
        this._compactRow.add_child(this._notch);

        // 4. Compact Album Art
        this._art = new St.Bin({
            style_class: 'di-art',
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactRow.add_child(this._art);

        // 5. Compact Title
        this._compactTitle = new St.Label({
            style_class: 'di-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._compactRow.add_child(this._compactTitle);

        // 6. Audio Visualizer
        this._eq = new St.DrawingArea({
            height: EQ_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._eq.connect('repaint', area => this._drawEq(area));
        this._eq.width = this._eqWidth();
        this._compactRow.add_child(this._eq);
        this._eqTimeline = new Clutter.Timeline({actor: this._eq, duration: 1000, repeat_count: -1});
        this._eqTimeline.connect('new-frame', () => this._stepEq(this._eqTimeline.get_delta() / 1000));

        // 7. Running Timer Badge on Compact Island
        this._timerBadge = new St.Button({
            style_class: 'di-timer-badge',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const timerBadgeBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        timerBadgeBox.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            style: 'icon-size: 13px; color: #30d158;',
        }));
        this._timerBadgeLabel = new St.Label({
            style_class: 'di-timer-badge-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        timerBadgeBox.add_child(this._timerBadgeLabel);
        this._timerBadge.set_child(timerBadgeBox);
        this._timerBadge.connect('clicked', () => {
            this._switchTab('hub', false);
            this._setExpanded(true);
        });
        this._compactRow.add_child(this._timerBadge);

        // 8. Pinned Quick Note Badge on Compact Island
        this._pinBadge = new St.Button({
            style_class: 'di-pin-badge',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const pinBadgeBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        pinBadgeBox.add_child(new St.Icon({
            icon_name: 'view-pin-symbolic',
            style: 'icon-size: 13px; color: #ffd60a;',
        }));
        this._pinBadgeLabel = new St.Label({
            style_class: 'di-pin-badge-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pinBadgeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        pinBadgeBox.add_child(this._pinBadgeLabel);
        this._pinBadge.set_child(pinBadgeBox);
        this._pinBadge.connect('clicked', () => {
            this._switchTab('notes', false);
            this._setExpanded(true);
        });
        this._compactRow.add_child(this._pinBadge);

        // 9. Unread Notifications Badge on Compact Island
        this._notifBadge = new St.Button({
            style_class: 'di-notif-badge',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const notifBadgeBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        notifBadgeBox.add_child(new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            style: 'icon-size: 12px; color: #b8b6ff;',
        }));
        this._notifBadgeLabel = new St.Label({
            style_class: 'di-notif-badge-label',
            text: '0',
            y_align: Clutter.ActorAlign.CENTER,
        });
        notifBadgeBox.add_child(this._notifBadgeLabel);
        this._notifBadge.set_child(notifBadgeBox);
        this._notifBadge.connect('clicked', () => {
            this._switchTab('media', false);
            this._setExpanded(true);
        });
        this._compactRow.add_child(this._notifBadge);

        // 9b. File Shelf Badge on Compact Island
        this._shelfBadge = new St.Button({
            style_class: 'di-shelf-badge',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const shelfBadgeBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 4px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        shelfBadgeBox.add_child(new St.Icon({
            icon_name: 'folder-symbolic',
            style: 'icon-size: 12px; color: #70b7ff;',
        }));
        this._shelfBadgeLabel = new St.Label({
            style_class: 'di-shelf-badge-label',
            text: '0',
            y_align: Clutter.ActorAlign.CENTER,
        });
        shelfBadgeBox.add_child(this._shelfBadgeLabel);
        this._shelfBadge.set_child(shelfBadgeBox);
        this._shelfBadge.connect('clicked', () => {
            this._switchTab('file', false);
            this._setExpanded(true);
        });
        this._compactRow.add_child(this._shelfBadge);

        // 10. Persistent Indicators (Recording, Download Progress)
        this._indicatorBox = new St.BoxLayout({
            style_class: 'di-indicators',
            orientation: Clutter.Orientation.HORIZONTAL,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactRow.add_child(this._indicatorBox);

        // 10. Compact Right Status Pill (Wi-Fi, Audio, Battery %)
        this._statusPill = new St.Button({
            style_class: 'di-status-pill',
            can_focus: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const statusBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusNetIcon = new St.Icon({
            style_class: 'di-status-icon',
            icon_name: 'network-wireless-signal-excellent-symbolic',
        });
        this._statusVolIcon = new St.Icon({
            style_class: 'di-status-icon',
            icon_name: 'audio-volume-high-symbolic',
        });
        this._statusBatIcon = new St.Icon({
            style_class: 'di-status-icon',
            icon_name: 'battery-good-symbolic',
        });
        this._statusBatLabel = new St.Label({
            style_class: 'di-status-label',
            text: '100%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._statusNetIcon);
        statusBox.add_child(this._statusVolIcon);
        statusBox.add_child(this._statusBatIcon);
        statusBox.add_child(this._statusBatLabel);
        this._statusPill.set_child(statusBox);
        this._statusPill.connect('clicked', () => {
            this._switchTab('system', false);
            this._setExpanded(true);
        });
        this._statusPill.connect('scroll-event', (actor, event) => {
            const dir = event.get_scroll_direction();
            const cur = this._sysControls?.getVolumeState().volume ?? 0.5;
            if (dir === Clutter.ScrollDirection.UP) {
                this._sysControls?.setVolume(cur + 0.05);
                return Clutter.EVENT_STOP;
            } else if (dir === Clutter.ScrollDirection.DOWN) {
                this._sysControls?.setVolume(cur - 0.05);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._compactRow.add_child(this._statusPill);

        // 11. Toast Overlay
        this._toastBox = new St.BoxLayout({
            style_class: 'di-toast',
            orientation: Clutter.Orientation.HORIZONTAL,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });
        this._toastIcon = new St.Icon({style_class: 'di-toast-icon'});
        this._toastBar = new St.Widget({
            style_class: 'di-level',
            width: BAR_W,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._toastFill = new St.Widget({style_class: 'di-level-fill', width: 0});
        this._toastBar.add_child(this._toastFill);
        this._toastLabel = new St.Label({
            style_class: 'di-toast-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._toastLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._toastBox.add_child(this._toastIcon);
        this._toastBox.add_child(this._toastBar);
        this._toastBox.add_child(this._toastLabel);
        this._compactRow.add_child(this._toastBox);
    }

    _buildExpandedView() {
        this._expandedRoot = new St.BoxLayout({
            style_class: 'di-expanded-root',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
            x_expand: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });
        this.add_child(this._expandedRoot);

        // Header Bar with Equal-Width 4-Tab Switcher (No Emojis, Clean Symbolic Icons) + Close Button
        const topRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 6px;',
        });

        this._tabBar = new St.BoxLayout({
            style_class: 'di-tab-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._tabButtons = new Map();
        const tabs = [
            ['media', 'multimedia-player-symbolic', 'Media'],
            ['hub', 'alarm-symbolic', 'Hub'],
            ['notes', 'document-edit-symbolic', 'Note'],
            ['file', 'folder-symbolic', 'File'],
            ['system', 'preferences-system-symbolic', 'Sistema'],
        ];
        for (const [id, iconName, labelText] of tabs) {
            const btn = new St.Button({
                style_class: 'di-tab-btn',
                can_focus: false,
                x_expand: true,
            });
            const btnBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 5px;',
            });
            btnBox.add_child(new St.Icon({
                icon_name: iconName,
                style: 'icon-size: 13px;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            btnBox.add_child(new St.Label({
                text: labelText,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            btn.set_child(btnBox);
            btn.connect('clicked', () => this._switchTab(id, true));
            this._tabBar.add_child(btn);
            this._tabButtons.set(id, btn);
        }
        topRow.add_child(this._tabBar);

        const closeBtn = new St.Button({
            style_class: 'di-icon-btn',
            child: new St.Icon({icon_name: 'window-close-symbolic', style: 'icon-size: 14px;'}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeBtn.connect('clicked', () => this._setExpanded(false));
        topRow.add_child(closeBtn);

        this._expandedRoot.add_child(topRow);

        // --- TAB 1: MEDIA & STATO ---
        this._mediaPage = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            x_expand: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });

        this._mediaCard = new St.BoxLayout({
            style_class: 'di-card',
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            x_expand: true,
        });

        const mediaTopRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 12px;',
        });

        this._expandedArt = new St.Button({
            style_class: 'di-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedArt.connect('clicked', () => this._player?.raise());
        mediaTopRow.add_child(this._expandedArt);

        this._text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 2px;',
        });
        this._source = new St.BoxLayout({
            style_class: 'di-source',
            orientation: Clutter.Orientation.HORIZONTAL,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sourceIcon = new St.Icon({style_class: 'di-source-icon'});
        this._sourceLabel = new St.Label({style_class: 'di-source-label', y_align: Clutter.ActorAlign.CENTER});
        this._source.add_child(this._sourceIcon);
        this._source.add_child(this._sourceLabel);
        this._text.add_child(this._source);

        this._title = new St.Label({style_class: 'di-title', text: 'Nessun media attivo'});
        this._artist = new St.Label({style_class: 'di-artist', text: 'Avvia Spotify, YouTube o un player'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._text.add_child(this._title);
        this._text.add_child(this._artist);
        mediaTopRow.add_child(this._text);

        this._controls = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 4px;',
        });
        this._controls.add_child(this._iconButton('media-skip-backward-symbolic', () => this._player?.previous()));
        this._playButton = this._iconButton('media-playback-start-symbolic', () => this._player?.playPause());
        this._playButton.add_style_class_name('di-play');
        this._controls.add_child(this._playButton);
        this._controls.add_child(this._iconButton('media-skip-forward-symbolic', () => this._player?.next()));
        mediaTopRow.add_child(this._controls);
        this._mediaCard.add_child(mediaTopRow);

        // Media Track Seek Row (Elapsed  [==== Slider ====]  Total)
        this._mediaSeekRow = new St.BoxLayout({
            style_class: 'di-media-seek-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._mediaCurLabel = new St.Label({
            style_class: 'di-media-time',
            text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaSeekSlider = new Slider(0);
        this._mediaSeekSlider.x_expand = true;
        this._mediaSeekSlider.connect('drag-begin', () => {
            this._mediaDragging = true;
            if (this._mediaSeekCommitId) {
                GLib.source_remove(this._mediaSeekCommitId);
                this._mediaSeekCommitId = 0;
            }
        });
        this._mediaSeekSlider.connect('drag-end', () => {
            this._mediaDragging = false;
            this._commitMediaSeek(this._mediaSeekSlider.value);
        });
        this._mediaSeekSlider.connect('notify::value', () => {
            if (this._syncingMediaSlider || this._mediaLengthUs <= 0)
                return;
            const previewUs = Math.round(this._mediaSeekSlider.value * this._mediaLengthUs);
            this._mediaCurLabel.text = this._formatMediaTime(previewUs);
            if (!this._mediaDragging) {
                if (this._mediaSeekCommitId)
                    GLib.source_remove(this._mediaSeekCommitId);
                this._mediaSeekCommitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    this._mediaSeekCommitId = 0;
                    this._commitMediaSeek(this._mediaSeekSlider.value);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        this._mediaDurLabel = new St.Label({
            style_class: 'di-media-time',
            text: '0:00',
            style: 'text-align: right;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaSeekRow.add_child(this._mediaCurLabel);
        this._mediaSeekRow.add_child(this._mediaSeekSlider);
        this._mediaSeekRow.add_child(this._mediaDurLabel);
        this._mediaCard.add_child(this._mediaSeekRow);

        this._mediaPage.add_child(this._mediaCard);

        // Notifications Section (Header with Clear All button + Scrollable List showing ~3 items)
        this._notifSection = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 6px;',
            visible: false,
            x_expand: true,
        });

        const notifHeader = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notifHeaderLabel = new St.Label({
            style_class: 'di-section-header',
            text: 'NOTIFICHE',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        notifHeader.add_child(this._notifHeaderLabel);

        const clearAllNotifsBtn = new St.Button({
            style_class: 'di-notif-clear-btn',
            label: 'Cancella tutte',
            y_align: Clutter.ActorAlign.CENTER,
        });
        clearAllNotifsBtn.connect('clicked', () => this.clearNotifications());
        notifHeader.add_child(clearAllNotifsBtn);
        this._notifSection.add_child(notifHeader);

        const notifScroll = new St.ScrollView({
            style_class: 'di-notif-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._notifListBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 5px;',
            x_expand: true,
        });
        notifScroll.set_child(this._notifListBox);
        this._notifSection.add_child(notifScroll);

        this._mediaPage.add_child(this._notifSection);

        this._expandedRoot.add_child(this._mediaPage);

        // --- TAB 2: HUB PRODUTTIVITÀ, CONSUMI & TIMER ---
        this._hubPage = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            visible: false,
            x_expand: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });

        // Row 1: Compact Clock + Battery Charge/Discharge Power & Voltage
        const hubTopRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 8px;',
            x_expand: true,
        });

        const dateBox = new St.BoxLayout({
            style_class: 'di-stat-pill',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._hubClockLabel = new St.Label({style_class: 'di-hub-clock-compact', text: '00:00:00'});
        this._hubDateLabel = new St.Label({style_class: 'di-muted-label', text: ''});
        dateBox.add_child(this._hubClockLabel);
        dateBox.add_child(this._hubDateLabel);
        hubTopRow.add_child(dateBox);

        this._powerPill = new St.BoxLayout({
            style_class: 'di-stat-pill',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 9px;',
        });
        this._powerIcon = new St.Icon({
            icon_name: 'battery-good-symbolic',
            style: 'icon-size: 18px; color: #e5e5ea;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const powerTextCol = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._powerValLabel = new St.Label({style_class: 'di-power-val', text: 'Alimentazione: -- W'});
        this._powerSubLabel = new St.Label({style_class: 'di-metric-sub', text: 'Tensione: -- V'});
        powerTextCol.add_child(this._powerValLabel);
        powerTextCol.add_child(this._powerSubLabel);
        this._powerPctLabel = new St.Label({
            style_class: 'di-power-pct',
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._powerPill.add_child(this._powerIcon);
        this._powerPill.add_child(powerTextCol);
        this._powerPill.add_child(this._powerPctLabel);
        hubTopRow.add_child(this._powerPill);

        this._hubPage.add_child(hubTopRow);

        // Row 2: Uniform 3x2 Telemetry Grid (CPU, RAM, GPU, Archivio, Rete, Temperature)
        const metricsGridLayout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 7,
            row_spacing: 7,
        });
        this._sysStatsBox = new St.Widget({
            layout_manager: metricsGridLayout,
            x_expand: true,
        });

        const makeMetricTile = (iconName, titleText, rgb, fixedMax = 100) => {
            const tile = new St.Widget({
                style_class: 'di-metric-tile',
                layout_manager: new Clutter.BinLayout(),
                clip_to_allocation: true,
                x_expand: true,
                y_expand: true,
            });
            const history = [];
            const chart = new St.DrawingArea({
                x_expand: true,
                y_expand: true,
            });
            chart.connect('repaint', area => this._drawMetricChart(area, history, rgb, fixedMax));

            const content = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_expand: true,
                style: 'padding: 7px 10px; spacing: 2px;',
            });
            const head = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style: 'spacing: 5px;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            head.add_child(new St.Icon({
                icon_name: iconName,
                style: 'icon-size: 12px; color: #98989d;',
            }));
            head.add_child(new St.Label({
                style_class: 'di-metric-title',
                text: titleText,
            }));
            const valLbl = new St.Label({style_class: 'di-metric-value', text: '--'});
            const subLbl = new St.Label({style_class: 'di-metric-sub', text: '--'});
            valLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            subLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            content.add_child(head);
            content.add_child(valLbl);
            content.add_child(subLbl);

            tile.add_child(chart);
            tile.add_child(content);
            return {tile, valLbl, subLbl, history, chart};
        };

        this._mCpu = makeMetricTile('processor-symbolic', 'CPU', [0.04, 0.52, 1.0]);
        this._mRam = makeMetricTile('drive-harddisk-solidstate-symbolic', 'RAM', [0.75, 0.35, 0.95]);
        this._mGpu = makeMetricTile('video-display-symbolic', 'GPU', [0.19, 0.82, 0.35]);
        this._mDisk = makeMetricTile('drive-harddisk-symbolic', 'ARCHIVIO', [1.0, 0.84, 0.04]);
        this._mNet = makeMetricTile('network-transmit-receive-symbolic', 'RETE', [0.39, 0.82, 1.0], 0);
        this._mTemp = makeMetricTile('temperature-symbolic', 'TEMPERATURE', [1.0, 0.41, 0.38]);

        metricsGridLayout.attach(this._mCpu.tile, 0, 0, 1, 1);
        metricsGridLayout.attach(this._mRam.tile, 1, 0, 1, 1);
        metricsGridLayout.attach(this._mGpu.tile, 2, 0, 1, 1);
        metricsGridLayout.attach(this._mDisk.tile, 0, 1, 1, 1);
        metricsGridLayout.attach(this._mNet.tile, 1, 1, 1, 1);
        metricsGridLayout.attach(this._mTemp.tile, 2, 1, 1, 1);

        this._hubPage.add_child(this._sysStatsBox);

        // Row 3: Compact Timer / Pomodoro Card
        const timerCard = new St.BoxLayout({
            style_class: 'di-card',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px; padding: 8px 12px;',
        });
        this._timerLabel = new St.Label({
            style_class: 'di-timer-display',
            text: formatTimer(this._timerRemaining),
            y_align: Clutter.ActorAlign.CENTER,
        });
        timerCard.add_child(this._timerLabel);

        const timerBtns = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 5px;',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const addBtn = (label, cb, accent = false) => {
            const b = new St.Button({
                style_class: accent ? 'di-pill-btn di-pill-btn-accent' : 'di-pill-btn',
                label,
                x_expand: true,
            });
            b.connect('clicked', cb);
            return b;
        };

        this._timerToggleBtn = addBtn('Avvia', () => this._toggleTimer(), true);
        timerBtns.add_child(this._timerToggleBtn);
        timerBtns.add_child(addBtn('+1m', () => this._adjustTimer(60)));
        timerBtns.add_child(addBtn('+5m', () => this._adjustTimer(300)));
        timerBtns.add_child(addBtn('25m', () => this._setTimer(25 * 60)));
        timerBtns.add_child(addBtn('Reset', () => this._setTimer(0)));

        timerCard.add_child(timerBtns);
        this._hubPage.add_child(timerCard);

        this._expandedRoot.add_child(this._hubPage);

        // --- TAB 3: TO-DO LIST (IN ALTO) + NOTE AMPIE (IN BASSO) ---
        this._notesPage = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            visible: false,
            x_expand: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });

        // Sezione 1 (In alto): To-Do List compatta
        const todoCard = new St.BoxLayout({
            style_class: 'di-card',
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 6px; padding: 8px 10px;',
            x_expand: true,
        });
        todoCard.add_child(new St.Label({
            style_class: 'di-section-header',
            text: 'TO-DO LIST',
        }));

        const addNoteRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 6px;',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._newNoteEntry = new St.Entry({
            style_class: 'di-entry',
            hint_text: 'Nuova attività (Invio per aggiungere)…',
            x_expand: true,
            can_focus: true,
        });
        this._newNoteEntry.clutter_text.connect('activate', () => this._addNoteFromEntry());
        addNoteRow.add_child(this._newNoteEntry);

        const addNoteBtn = new St.Button({
            style_class: 'di-pill-btn di-pill-btn-accent',
            label: 'Aggiungi',
        });
        addNoteBtn.connect('clicked', () => this._addNoteFromEntry());
        addNoteRow.add_child(addNoteBtn);
        todoCard.add_child(addNoteRow);

        const todoScroll = new St.ScrollView({
            style_class: 'di-todo-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._notesListBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 4px;',
            x_expand: true,
        });
        todoScroll.set_child(this._notesListBox);
        todoCard.add_child(todoScroll);
        this._notesPage.add_child(todoCard);

        // Sezione 2 (In basso): Riquadro grande dedicato alle Note multi-riga
        const notesCard = new St.BoxLayout({
            style_class: 'di-card',
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 6px; padding: 9px 10px;',
            x_expand: true,
        });

        const notesHeader = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        notesHeader.add_child(new St.Label({
            style_class: 'di-section-header',
            text: 'NOTE',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const copyScratchBtn = new St.Button({
            style_class: 'di-icon-btn',
            child: new St.Icon({icon_name: 'edit-copy-symbolic', style: 'icon-size: 13px;'}),
        });
        copyScratchBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._scratchEntry.get_text());
            this.toast('edit-copy-symbolic', 'Note copiate negli appunti', {duration: 1400});
        });
        notesHeader.add_child(copyScratchBtn);

        const clearScratchBtn = new St.Button({
            style_class: 'di-icon-btn',
            child: new St.Icon({icon_name: 'edit-clear-symbolic', style: 'icon-size: 13px;'}),
        });
        clearScratchBtn.connect('clicked', () => {
            this._scratchEntry.set_text('');
            this._settings.set_string('scratchpad-text', '');
        });
        notesHeader.add_child(clearScratchBtn);
        notesCard.add_child(notesHeader);

        const notesScroll = new St.ScrollView({
            style_class: 'di-notes-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            reactive: true,
            x_expand: true,
        });
        const notesInnerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });
        this._scratchEntry = new St.Entry({
            style_class: 'di-notes-editor',
            hint_text: 'Scrivi qui le tue note libere (salvataggio automatico)…',
            text: this._settings.get_string('scratchpad-text'),
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            can_focus: true,
        });
        this._scratchEntry.clutter_text.set({
            single_line_mode: false,
            activatable: false,
            editable: true,
            selectable: true,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        notesScroll.connect('button-press-event', () => {
            this._scratchEntry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
        notesInnerBox.connect('button-press-event', () => {
            this._scratchEntry.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
        this._scratchEntry.clutter_text.connect('text-changed', () => {
            const txt = this._scratchEntry.get_text();
            if (txt !== this._settings.get_string('scratchpad-text'))
                this._settings.set_string('scratchpad-text', txt);
        });
        notesInnerBox.add_child(this._scratchEntry);
        notesScroll.set_child(notesInnerBox);
        notesCard.add_child(notesScroll);
        this._notesPage.add_child(notesCard);

        this._expandedRoot.add_child(this._notesPage);

        // --- TAB 4: FILE SHELF (MENSOLA FILE & IMMAGINI) ---
        this._buildFilePage();
        this._expandedRoot.add_child(this._filePage);

        // --- TAB 5: SISTEMA (QUICK SETTINGS ELEGANTI E UNIFORMI) ---
        this._buildSystemPage();
        this._expandedRoot.add_child(this._systemPage);

        this._switchTab('media', false);
    }

    _syncShelfTrayVisibility() {
        if (!this._fileShelf)
            return;
        const count = Math.min(8, this._shelfFiles?.length ?? 0);
        const shouldShow = this._shown && !this._expanded &&
            !this._dragOpening && count > 0;
        if (shouldShow) {
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor)
                return;
            const w = count * 44 + Math.max(0, count - 1) * 6 + 14;
            const h = 56;
            const x = monitor.x + Math.floor((monitor.width - w) / 2);
            let baseY = (this._targetY ?? this.y) + (this._targetH ?? this.height);
            if (this._belowToast?.visible)
                baseY = Math.max(baseY, this._belowToast.y + this._belowToast.height);
            let y = baseY + 6;
            if (y + h > monitor.y + monitor.height - 8)
                y = Math.max(monitor.y + 4, (this._targetY ?? this.y) - h - 6);

            const tiles = this._shelfFiles.slice(0, 8).map(f => {
                let iconName = 'text-x-generic-symbolic';
                try {
                    const names = f.icon?.get_names?.();
                    if (names?.length)
                        iconName = names[0];
                } catch (e) {
                    // Fallback
                }
                return {uri: f.uri, name: f.name, isImage: f.isImage, iconName};
            });
            this._fileShelf.showTray({x: Math.round(x), y: Math.round(y), width: w, height: h}, tiles);
        } else {
            this._fileShelf.hideTray();
        }
    }

    _rebuildShelfTray() {
        this._syncShelfTrayVisibility();
    }

    _buildFilePage() {
        this._filePage = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            visible: false,
            x_expand: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });

        // Drop Zone + Paste/Clear Header
        this._dropZone = new St.BoxLayout({
            style_class: 'di-drop-zone',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dropZone.add_child(new St.Icon({
            icon_name: 'folder-download-symbolic',
            style: 'icon-size: 16px; color: #70b7ff;',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._dropZoneLabel = new St.Label({
            style_class: 'di-muted-label',
            text: 'Trascina qui immagini o file',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dropZone.add_child(this._dropZoneLabel);

        const pasteBtn = new St.Button({
            style_class: 'di-pill-btn',
            label: 'Incolla file',
            y_align: Clutter.ActorAlign.CENTER,
        });
        pasteBtn.connect('clicked', () => {
            this._fileShelf?.pasteUrisFromClipboard(uris => this.addShelfFiles(uris));
        });
        this._dropZone.add_child(pasteBtn);

        this._shelfClearBtn = new St.Button({
            style_class: 'di-notif-clear-btn',
            label: 'Svuota',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._shelfClearBtn.connect('clicked', () => {
            this._shelfFiles = [];
            this._rebuildShelfUI();
            this._refresh();
        });
        this._dropZone.add_child(this._shelfClearBtn);

        this._filePage.add_child(this._dropZone);

        // Scrollable File Cards List
        this._shelfScroll = new St.ScrollView({
            style_class: 'di-shelf-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._shelfListBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 5px;',
            x_expand: true,
        });
        this._shelfScroll.set_child(this._shelfListBox);
        this._filePage.add_child(this._shelfScroll);

        this._rebuildShelfUI();
    }

    addShelfFiles(uris) {
        if (!Array.isArray(uris) || uris.length === 0)
            return;
        let added = 0;
        for (const uri of uris) {
            if (this._shelfFiles.some(f => f.uri === uri))
                continue;
            try {
                const file = Gio.File.new_for_uri(uri);
                const info = file.query_info('standard::display-name,standard::size,standard::content-type,standard::icon',
                    Gio.FileQueryInfoFlags.NONE, null);
                const name = info.get_display_name() || file.get_basename() || 'File';
                const size = info.get_size();
                const contentType = info.get_content_type() || '';
                const icon = info.get_icon();
                const isImage = contentType.startsWith('image/') ||
                    /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name);

                this._shelfFiles.unshift({
                    uri,
                    name,
                    sizeText: size > 1048576
                        ? `${(size / 1048576).toFixed(1)} MB`
                        : `${Math.max(1, Math.round(size / 1024))} KB`,
                    icon,
                    isImage,
                });
                added++;
            } catch (e) {
                // Skip unreadable file URI
            }
        }
        if (added > 0) {
            this._rebuildShelfUI();
            this._refresh();
        }
    }

    _rebuildShelfUI() {
        if (!this._shelfListBox)
            return;
        this._shelfListBox.destroy_all_children();

        const count = this._shelfFiles.length;
        if (this._shelfBadgeLabel)
            this._shelfBadgeLabel.text = `${count}`;
        if (this._shelfBadge)
            this._shelfBadge.visible = count > 0;
        if (this._shelfClearBtn)
            this._shelfClearBtn.visible = count > 0;
        if (this._shelfScroll && !this._dragOpening)
            this._shelfScroll.visible = count > 0;
        if (this._dropZone && !this._dragOpening) {
            if (count === 0)
                this._dropZone.add_style_class_name('di-drop-zone-tall');
            else
                this._dropZone.remove_style_class_name('di-drop-zone-tall');
        }

        if (count === 0) {
            this._rebuildShelfTray();
            return;
        }

        for (const item of this._shelfFiles) {
            const row = new St.BoxLayout({
                style_class: 'di-shelf-item',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // Thumbnail or File Icon (Clickable to open)
            const previewBtn = new St.Button({
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (item.isImage) {
                previewBtn.set_child(new St.Bin({
                    style_class: 'di-shelf-thumb',
                    style: `background-image: url("${item.uri}");`,
                }));
            } else {
                const iconBox = new St.Bin({
                    style_class: 'di-shelf-thumb',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                iconBox.set_child(new St.Icon({
                    gicon: item.icon || new Gio.ThemedIcon({name: 'text-x-generic-symbolic'}),
                    style: 'icon-size: 18px; color: #e5e5ea;',
                }));
                previewBtn.set_child(iconBox);
            }
            previewBtn.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(item.uri, null);
                } catch (e) {
                    // Ignore open errors
                }
            });
            row.add_child(previewBtn);

            // File Name + Size (Clickable to open)
            const infoBtn = new St.Button({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const textCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const nameLbl = new St.Label({style_class: 'di-qs-title', text: item.name});
            const sizeLbl = new St.Label({style_class: 'di-qs-sub', text: item.sizeText});
            nameLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(nameLbl);
            textCol.add_child(sizeLbl);
            infoBtn.set_child(textCol);
            infoBtn.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(item.uri, null);
                } catch (e) {
                    // Ignore
                }
            });
            row.add_child(infoBtn);

            // Drag Out button
            const dragBtn = new St.Button({
                style_class: 'di-pill-btn',
                label: 'Trascina',
                y_align: Clutter.ActorAlign.CENTER,
            });
            dragBtn.connect('clicked', () => {
                this._fileShelf?.startDragOut([item.uri], item.name);
            });
            row.add_child(dragBtn);

            // Copy button
            const copyBtn = new St.Button({
                style_class: 'di-icon-btn',
                child: new St.Icon({icon_name: 'edit-copy-symbolic', style: 'icon-size: 13px;'}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            copyBtn.connect('clicked', () => {
                this._fileShelf?.copyUrisToClipboard([item.uri]);
                this.toast('edit-copy-symbolic', `${item.name} copiato`, {duration: 1400});
            });
            row.add_child(copyBtn);

            // Remove button
            const delBtn = new St.Button({
                style_class: 'di-icon-btn',
                child: new St.Icon({icon_name: 'window-close-symbolic', style: 'icon-size: 12px;'}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            delBtn.connect('clicked', () => {
                this._shelfFiles = this._shelfFiles.filter(f => f.uri !== item.uri);
                this._rebuildShelfUI();
                this._refresh();
            });
            row.add_child(delBtn);

            this._shelfListBox.add_child(row);
        }
        this._rebuildShelfTray();
    }

    _buildSystemPage() {
        this._systemPage = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            visible: false,
            x_expand: true,
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });

        this._systemMainBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            x_expand: true,
        });
        this._systemPage.add_child(this._systemMainBox);

        // 1. Sliders Card (Volume & Brightness)
        const slidersCard = new St.BoxLayout({
            style_class: 'di-card',
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 6px;',
            x_expand: true,
        });

        const volRow = new St.BoxLayout({
            style_class: 'di-slider-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sysVolBtn = new St.Button({
            style_class: 'di-slider-icon-btn',
            child: new St.Icon({icon_name: 'audio-volume-high-symbolic', style: 'icon-size: 16px;'}),
        });
        this._sysVolBtn.connect('clicked', () => this._sysControls?.toggleMute());
        this._sysVolSlider = new Slider(0);
        this._sysVolSlider.x_expand = true;
        this._sysVolSlider.connect('notify::value', () => {
            if (this._syncingSliders)
                return;
            this._sysControls?.setVolume(this._sysVolSlider.value);
            this._sysVolPct.text = `${Math.round(this._sysVolSlider.value * 100)}%`;
        });
        this._sysVolPct = new St.Label({
            style_class: 'di-slider-pct',
            text: '100%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        volRow.add_child(this._sysVolBtn);
        volRow.add_child(this._sysVolSlider);
        volRow.add_child(this._sysVolPct);
        slidersCard.add_child(volRow);

        this._brightRow = new St.BoxLayout({
            style_class: 'di-slider-row',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const brightIconBtn = new St.Button({
            style_class: 'di-slider-icon-btn',
            child: new St.Icon({icon_name: 'display-brightness-symbolic', style: 'icon-size: 16px;'}),
            reactive: false,
        });
        this._sysBrightSlider = new Slider(1);
        this._sysBrightSlider.x_expand = true;
        this._sysBrightSlider.connect('notify::value', () => {
            if (this._syncingSliders)
                return;
            this._sysControls?.setBrightness(this._sysBrightSlider.value);
            this._sysBrightPct.text = `${Math.round(this._sysBrightSlider.value * 100)}%`;
        });
        this._sysBrightPct = new St.Label({
            style_class: 'di-slider-pct',
            text: '100%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._brightRow.add_child(brightIconBtn);
        this._brightRow.add_child(this._sysBrightSlider);
        this._brightRow.add_child(this._sysBrightPct);
        slidersCard.add_child(this._brightRow);

        this._systemMainBox.add_child(slidersCard);

        // 2. Uniform 2x3 Grid of Quick Toggles
        const gridLayout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 8,
            row_spacing: 8,
        });
        const togglesGrid = new St.Widget({
            layout_manager: gridLayout,
            x_expand: true,
        });

        const makeToggle = (iconName, title, subtitle, onClick) => {
            const btn = new St.Button({
                style_class: 'di-qs-toggle',
                x_expand: true,
                y_expand: true,
            });
            const box = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style: 'spacing: 9px;',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const iconCircle = new St.Bin({
                style_class: 'di-qs-icon-circle',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const icon = new St.Icon({
                icon_name: iconName,
                style: 'icon-size: 15px;',
            });
            iconCircle.set_child(icon);

            const textCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const titleLbl = new St.Label({style_class: 'di-qs-title', text: title});
            const subLbl = new St.Label({style_class: 'di-qs-sub', text: subtitle});
            titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            subLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(titleLbl);
            textCol.add_child(subLbl);

            box.add_child(iconCircle);
            box.add_child(textCol);
            btn.set_child(box);
            btn.connect('clicked', onClick);
            return {btn, icon, titleLbl, subLbl};
        };

        const makeSplitToggle = (iconName, title, subtitle, onToggle, onExpand) => {
            const container = new St.BoxLayout({
                style_class: 'di-qs-split',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_expand: true,
            });

            // Left compact button: Icon only -> Toggle ON/OFF
            const leftBtn = new St.Button({
                style_class: 'di-qs-split-left',
                y_expand: true,
            });
            const iconCircle = new St.Bin({
                style_class: 'di-qs-icon-circle',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            const icon = new St.Icon({
                icon_name: iconName,
                style: 'icon-size: 15px;',
            });
            iconCircle.set_child(icon);
            leftBtn.set_child(iconCircle);
            leftBtn.connect('clicked', onToggle);

            const sep = new St.Widget({style_class: 'di-qs-split-sep'});

            // Right wider button: Title + Subtitle + Chevron -> Open selection list
            const rightBtn = new St.Button({
                style_class: 'di-qs-split-right',
                x_expand: true,
                y_expand: true,
            });
            const rightBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style: 'spacing: 6px;',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const textCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const titleLbl = new St.Label({style_class: 'di-qs-title', text: title});
            const subLbl = new St.Label({style_class: 'di-qs-sub', text: subtitle});
            titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            subLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(titleLbl);
            textCol.add_child(subLbl);

            rightBox.add_child(textCol);
            rightBox.add_child(new St.Icon({
                icon_name: 'go-next-symbolic',
                style: 'icon-size: 13px; color: rgba(255,255,255,0.75);',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            rightBtn.set_child(rightBox);
            rightBtn.connect('clicked', onExpand);

            container.add_child(leftBtn);
            container.add_child(sep);
            container.add_child(rightBtn);
            return {btn: container, icon, titleLbl, subLbl};
        };

        this._qsWifi = makeSplitToggle(
            'network-wireless-signal-excellent-symbolic',
            'Wi-Fi',
            'Attivo',
            () => {
                const net = this._sysControls?.getNetworkState();
                this._sysControls?.setWifiEnabled(!net?.enabled);
            },
            () => this._openSystemSubView('wifi')
        );
        this._qsBt = makeSplitToggle(
            'bluetooth-active-symbolic',
            'Bluetooth',
            'Disattivato',
            () => {
                const bt = this._sysControls?.getBluetoothState();
                this._sysControls?.setBluetoothPowered(!bt?.powered);
            },
            () => this._openSystemSubView('bluetooth')
        );
        this._qsNight = makeToggle('night-light-symbolic', 'Luce Notturna', 'Disattivata', () => {
            this._sysControls?.toggleNightLight();
        });
        this._qsDnd = makeToggle('notifications-disabled-symbolic', 'Non Disturbare', 'Disattivato', () => {
            this._sysControls?.toggleDnd();
        });
        this._qsPower = makeToggle('power-profile-balanced-symbolic', 'Profilo Energetico', 'Bilanciato', () => {
            this._sysControls?.cyclePowerProfile();
        });
        this._qsGnomeMenu = makeToggle('view-more-symbolic', 'Menu di Sistema', 'Pannello GNOME', () => {
            this._setExpanded(false);
            this._sysControls?.openNativeQuickSettings(this);
        });

        gridLayout.attach(this._qsWifi.btn, 0, 0, 1, 1);
        gridLayout.attach(this._qsBt.btn, 1, 0, 1, 1);
        gridLayout.attach(this._qsNight.btn, 0, 1, 1, 1);
        gridLayout.attach(this._qsDnd.btn, 1, 1, 1, 1);
        gridLayout.attach(this._qsPower.btn, 0, 2, 1, 1);
        gridLayout.attach(this._qsGnomeMenu.btn, 1, 2, 1, 1);

        this._systemMainBox.add_child(togglesGrid);

        // 3. Uniform 6-Button System Actions Bar
        const actionsGridLayout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
            column_spacing: 6,
        });
        const actionsGrid = new St.Widget({
            layout_manager: actionsGridLayout,
            x_expand: true,
        });

        const sysActions = [
            ['preferences-system-symbolic', 'Impostazioni', false, () => {
                this._setExpanded(false);
                this._sysControls?.openGnomeSettings();
            }],
            ['camera-photo-symbolic', 'Schermata', false, () => {
                this._setExpanded(false);
                this._sysControls?.takeScreenshot();
            }],
            ['system-lock-screen-symbolic', 'Blocca', false, () => {
                this._setExpanded(false);
                this._sysControls?.lockScreen();
            }],
            ['weather-clear-night-symbolic', 'Sospendi', false, () => {
                this._setExpanded(false);
                this._sysControls?.suspend();
            }],
            ['system-reboot-symbolic', 'Riavvia', false, () => {
                this._setExpanded(false);
                if (this._sysControls?.restart)
                    this._sysControls.restart();
                else
                    SystemActions.getDefault().activateRestart();
            }],
            ['system-shutdown-symbolic', 'Spegni', true, () => {
                this._setExpanded(false);
                this._sysControls?.powerOff();
            }],
        ];

        sysActions.forEach(([iconName, labelText, danger, cb], idx) => {
            const btn = new St.Button({
                style_class: danger ? 'di-sys-action-btn di-sys-action-danger' : 'di-sys-action-btn',
                x_expand: true,
                y_expand: true,
            });
            const col = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 3px;',
            });
            col.add_child(new St.Icon({
                icon_name: iconName,
                style: 'icon-size: 15px;',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const lbl = new St.Label({
                style_class: 'di-sys-action-label',
                text: labelText,
                x_align: Clutter.ActorAlign.CENTER,
            });
            col.add_child(lbl);
            btn.set_child(col);
            btn.connect('clicked', cb);
            actionsGridLayout.attach(btn, idx, 0, 1, 1);
        });

        this._systemMainBox.add_child(actionsGrid);

        // 4. Wi-Fi & Bluetooth Sub-Panel (Windows-style expandable list + ON/OFF switch)
        this._systemSubBox = new St.BoxLayout({
            style_class: 'di-card',
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 8px;',
            visible: false,
            x_expand: true,
        });

        const subHeader = new St.BoxLayout({
            style_class: 'di-sub-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const backBtn = new St.Button({
            style_class: 'di-icon-btn',
            child: new St.Icon({icon_name: 'go-previous-symbolic', style: 'icon-size: 15px;'}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        backBtn.connect('clicked', () => this._openSystemSubView(null));
        subHeader.add_child(backBtn);

        this._subTitleLabel = new St.Label({
            style_class: 'di-title',
            text: 'Wi-Fi',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        subHeader.add_child(this._subTitleLabel);

        this._subSwitchBtn = new St.Button({
            style_class: 'di-switch-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const switchTrack = new St.Widget({
            width: 38,
            height: 18,
            layout_manager: new Clutter.BinLayout(),
        });
        this._subSwitchKnob = new St.Widget({
            style_class: 'di-switch-knob',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        switchTrack.add_child(this._subSwitchKnob);
        this._subSwitchBtn.set_child(switchTrack);
        this._subSwitchBtn.connect('clicked', () => {
            if (this._systemSubView === 'wifi') {
                const net = this._sysControls?.getNetworkState();
                this._sysControls?.setWifiEnabled(!net?.enabled);
            } else if (this._systemSubView === 'bluetooth') {
                const bt = this._sysControls?.getBluetoothState();
                this._sysControls?.setBluetoothPowered(!bt?.powered);
            }
        });
        subHeader.add_child(this._subSwitchBtn);
        this._systemSubBox.add_child(subHeader);

        // Optional inline Wi-Fi password bar
        this._wifiPwdRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 6px;',
            visible: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._wifiPwdEntry = new St.Entry({
            style_class: 'di-entry',
            hint_text: 'Password Wi-Fi…',
            x_expand: true,
            can_focus: true,
        });
        this._wifiPwdEntry.clutter_text.set_password_char('•');
        this._wifiPwdEntry.clutter_text.connect('activate', () => this._submitWifiPassword());
        this._wifiPwdRow.add_child(this._wifiPwdEntry);

        const wifiPwdConnectBtn = new St.Button({
            style_class: 'di-pill-btn di-pill-btn-accent',
            label: 'Connetti',
        });
        wifiPwdConnectBtn.connect('clicked', () => this._submitWifiPassword());
        this._wifiPwdRow.add_child(wifiPwdConnectBtn);
        this._systemSubBox.add_child(this._wifiPwdRow);

        const subScroll = new St.ScrollView({
            style_class: 'di-device-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        this._subListBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 5px;',
            x_expand: true,
        });
        subScroll.set_child(this._subListBox);
        this._systemSubBox.add_child(subScroll);

        const subFooter = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style: 'spacing: 6px;',
        });
        this._subSettingsBtn = new St.Button({
            style_class: 'di-pill-btn',
            label: 'Altre impostazioni…',
            x_expand: true,
        });
        this._subSettingsBtn.connect('clicked', () => {
            const panel = this._systemSubView === 'bluetooth' ? 'bluetooth' : 'wifi';
            this._setExpanded(false);
            this._sysControls?.openGnomeSettings(panel);
        });
        subFooter.add_child(this._subSettingsBtn);
        this._systemSubBox.add_child(subFooter);

        this._systemPage.add_child(this._systemSubBox);
    }

    _setSubSwitchState(isOn) {
        if (!this._subSwitchBtn || !this._subSwitchKnob)
            return;
        if (isOn)
            this._subSwitchBtn.add_style_class_name('di-switch-pill-on');
        else
            this._subSwitchBtn.remove_style_class_name('di-switch-pill-on');

        this._subSwitchKnob.ease({
            translation_x: isOn ? 20 : 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _openSystemSubView(view) {
        this._systemSubView = view;
        this._pendingWifi = null;
        if (this._wifiPwdRow) {
            this._wifiPwdRow.visible = false;
            this._wifiPwdEntry.set_text('');
        }
        this._systemMainBox.visible = !view;
        this._systemSubBox.visible = !!view;
        if (view === 'wifi')
            this._sysControls?.scanWifi();
        this._rebuildSystemSubList();
        this._refresh();
    }

    _submitWifiPassword() {
        if (!this._pendingWifi)
            return;
        const pwd = this._wifiPwdEntry.get_text();
        if (!pwd)
            return;
        const {ssid, apPath} = this._pendingWifi;
        this._wifiPwdRow.visible = false;
        this._wifiPwdEntry.set_text('');
        this._pendingWifi = null;
        this._sysControls?.connectWifi(ssid, apPath, pwd, ok => {
            if (!ok)
                this.toast('network-wireless-offline-symbolic', `Connessione a ${ssid} fallita`, {duration: 2500});
            this._rebuildSystemSubList();
        });
    }

    _rebuildSystemSubList() {
        if (!this._subListBox || !this._systemSubView || !this._sysControls)
            return;
        this._subListBox.destroy_all_children();

        if (this._systemSubView === 'wifi') {
            const net = this._sysControls.getNetworkState();
            this._subTitleLabel.text = 'Reti Wi-Fi';
            this._setSubSwitchState(net.enabled);

            if (!net.enabled) {
                this._subListBox.add_child(new St.Label({
                    style_class: 'di-muted-label',
                    text: 'Wi-Fi disattivato. Premi Attiva in alto per cercare le reti.',
                }));
                return;
            }

            const networks = this._sysControls.getWifiNetworks();
            if (networks.length === 0) {
                this._subListBox.add_child(new St.Label({
                    style_class: 'di-muted-label',
                    text: 'Ricerca reti Wi-Fi in corso…',
                }));
                return;
            }

            for (const ap of networks) {
                const rowBtn = new St.Button({
                    style_class: ap.active ? 'di-device-row di-device-row-active' : 'di-device-row',
                    x_expand: true,
                });
                const row = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    style: 'spacing: 9px;',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const sigIcon = ap.strength > 70
                    ? 'network-wireless-signal-excellent-symbolic'
                    : ap.strength > 45
                        ? 'network-wireless-signal-good-symbolic'
                        : 'network-wireless-signal-ok-symbolic';
                row.add_child(new St.Icon({icon_name: sigIcon, style: 'icon-size: 16px; color: #ffffff;'}));

                const textCol = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    x_expand: true,
                });
                const isBusy = this._wifiBusySsid === ap.ssid;
                const nameLbl = new St.Label({style_class: 'di-qs-title', text: ap.ssid});
                const subLbl = new St.Label({
                    style_class: 'di-qs-sub',
                    text: isBusy
                        ? (ap.active ? 'Disconnessione…' : 'Connessione…')
                        : (ap.active ? 'Connesso · Clicca per disconnettere' : (ap.saved ? 'Salvata · Clicca per connettere' : `${ap.strength}%`)),
                });
                nameLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                textCol.add_child(nameLbl);
                textCol.add_child(subLbl);
                row.add_child(textCol);

                if (ap.secured && !ap.active)
                    row.add_child(new St.Icon({icon_name: 'network-wireless-encrypted-symbolic', style: 'icon-size: 13px; color: #98989d;'}));
                if (ap.active)
                    row.add_child(new St.Icon({icon_name: 'object-select-symbolic', style: 'icon-size: 15px; color: #0a84ff;'}));

                rowBtn.set_child(row);
                rowBtn.connect('clicked', () => {
                    if (this._wifiBusySsid)
                        return;
                    if (ap.active) {
                        this._wifiBusySsid = ap.ssid;
                        this._rebuildSystemSubList();
                        this._sysControls.disconnectWifi(ok => {
                            this._wifiBusySsid = null;
                            if (!ok)
                                this.toast('network-wireless-offline-symbolic', `Impossibile disconnettere ${ap.ssid}`, {duration: 2400});
                            this._rebuildSystemSubList();
                        });
                        return;
                    }
                    this._wifiBusySsid = ap.ssid;
                    const res = this._sysControls.connectWifi(ap.ssid, ap.apPath, null, ok => {
                        this._wifiBusySsid = null;
                        if (!ok)
                            this.toast('network-wireless-offline-symbolic', `Impossibile connettersi a ${ap.ssid}`, {duration: 2400});
                        this._rebuildSystemSubList();
                    });
                    if (res.needsPassword) {
                        this._wifiBusySsid = null;
                        this._pendingWifi = {ssid: ap.ssid, apPath: ap.apPath};
                        this._wifiPwdEntry.hint_text = `Password per ${ap.ssid}…`;
                        this._wifiPwdRow.visible = true;
                        this._wifiPwdEntry.grab_key_focus();
                        this._refresh();
                    } else if (res.started) {
                        this._rebuildSystemSubList();
                    } else {
                        this._wifiBusySsid = null;
                    }
                });
                this._subListBox.add_child(rowBtn);
            }
        } else if (this._systemSubView === 'bluetooth') {
            const bt = this._sysControls.getBluetoothState();
            this._subTitleLabel.text = 'Dispositivi Bluetooth';
            this._setSubSwitchState(bt.powered);

            if (!bt.powered) {
                this._subListBox.add_child(new St.Label({
                    style_class: 'di-muted-label',
                    text: 'Bluetooth disattivato. Premi Attivo in alto per accenderlo.',
                }));
                return;
            }

            const devices = this._sysControls.getBluetoothDevices();
            if (devices.length === 0) {
                this._subListBox.add_child(new St.Label({
                    style_class: 'di-muted-label',
                    text: 'Nessun dispositivo associato. Usa Altre impostazioni per associare nuovi dispositivi.',
                }));
                return;
            }

            for (const dev of devices) {
                const rowBtn = new St.Button({
                    style_class: dev.connected ? 'di-device-row di-device-row-active' : 'di-device-row',
                    x_expand: true,
                });
                const row = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    style: 'spacing: 9px;',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.add_child(new St.Icon({
                    icon_name: dev.icon,
                    fallback_icon_name: 'bluetooth-active-symbolic',
                    style: 'icon-size: 16px; color: #ffffff;',
                }));

                const textCol = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    x_expand: true,
                });
                const isBusy = this._btBusyPath === dev.path;
                const nameLbl = new St.Label({style_class: 'di-qs-title', text: dev.name});
                const batStr = dev.battery !== null ? ` · Batteria ${dev.battery}%` : '';
                const subLbl = new St.Label({
                    style_class: 'di-qs-sub',
                    text: isBusy
                        ? (dev.connected ? 'Disconnessione…' : 'Connessione…')
                        : ((dev.connected ? 'Connesso' : 'Disconnesso') + batStr),
                });
                nameLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                textCol.add_child(nameLbl);
                textCol.add_child(subLbl);
                row.add_child(textCol);

                row.add_child(new St.Label({
                    style_class: 'di-muted-label',
                    text: isBusy ? 'Attendere…' : (dev.connected ? 'Disconnetti' : 'Connetti'),
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                rowBtn.set_child(row);
                rowBtn.connect('clicked', () => {
                    if (this._btBusyPath === dev.path)
                        return;
                    this._btBusyPath = dev.path;
                    this._rebuildSystemSubList();
                    this._sysControls.toggleBluetoothDevice(dev.path, !dev.connected, ok => {
                        this._btBusyPath = null;
                        if (!ok) {
                            const verb = dev.connected ? 'disconnettere' : 'connettere';
                            this.toast('bluetooth-active-symbolic', `Impossibile ${verb} ${dev.name}`, {
                                duration: 2400,
                                placementGroup: 'alert',
                            });
                        }
                        this._rebuildSystemSubList();
                    });
                });
                this._subListBox.add_child(rowBtn);
            }
        }
    }

    _syncSystemControlsUI() {
        if (this._destroyed || !this._sysControls)
            return;

        // Compact status bar icons (diff-checked to avoid redundant relayouts)
        const vol = this._sysControls.getVolumeState();
        if (this._statusVolIcon.icon_name !== vol.icon)
            this._statusVolIcon.icon_name = vol.icon;

        const bat = this._sysControls.getBatteryState();
        if (this._statusBatIcon.visible !== bat.present)
            this._statusBatIcon.visible = bat.present;
        if (this._statusBatLabel.visible !== bat.present)
            this._statusBatLabel.visible = bat.present;
        if (bat.present) {
            if (this._statusBatIcon.icon_name !== bat.icon)
                this._statusBatIcon.icon_name = bat.icon;
            const batTxt = `${bat.percent}%`;
            if (this._statusBatLabel.text !== batTxt)
                this._statusBatLabel.text = batTxt;
        }

        const net = this._sysControls.getNetworkState();
        if (this._statusNetIcon.icon_name !== net.icon)
            this._statusNetIcon.icon_name = net.icon;

        // Defer full Sistema tab widget & sub-list updates when not visible
        if (!(this._expanded && this._activeTab === 'system')) {
            this._sysControlsDirty = true;
            return;
        }
        this._sysControlsDirty = false;

        this._syncingSliders = true;
        try {
            // 1. Volume
            this._sysVolBtn.child.icon_name = vol.icon;
            const effectiveVol = vol.muted ? 0 : vol.volume;
            this._sysVolSlider.value = effectiveVol;
            this._sysVolPct.text = `${Math.round(effectiveVol * 100)}%`;

            // 2. Brightness
            const bright = this._sysControls.getBrightnessState();
            this._brightRow.visible = bright.available;
            if (bright.available) {
                this._sysBrightSlider.value = bright.value;
                this._sysBrightPct.text = `${Math.round(bright.value * 100)}%`;
            }

            // 3. Wi-Fi / Network
            this._qsWifi.icon.icon_name = net.icon;
            this._qsWifi.titleLbl.text = net.label;
            this._qsWifi.subLbl.text = net.sub;
            if (net.enabled)
                this._qsWifi.btn.add_style_class_name('di-qs-split-active');
            else
                this._qsWifi.btn.remove_style_class_name('di-qs-split-active');

            // 5. Bluetooth
            const bt = this._sysControls.getBluetoothState();
            this._qsBt.subLbl.text = bt.sub;
            if (bt.powered)
                this._qsBt.btn.add_style_class_name('di-qs-split-active');
            else
                this._qsBt.btn.remove_style_class_name('di-qs-split-active');

            // 6. Night Light
            const night = this._sysControls.getNightLight();
            this._qsNight.subLbl.text = night ? 'Attiva' : 'Disattivata';
            if (night)
                this._qsNight.btn.add_style_class_name('di-qs-toggle-warm');
            else
                this._qsNight.btn.remove_style_class_name('di-qs-toggle-warm');

            // 6. Do Not Disturb
            const dnd = this._sysControls.getDnd();
            this._qsDnd.subLbl.text = dnd ? 'Attivo' : 'Disattivato';
            if (dnd)
                this._qsDnd.btn.add_style_class_name('di-qs-toggle-purple');
            else
                this._qsDnd.btn.remove_style_class_name('di-qs-toggle-purple');

            // 7. Power Profile
            const pp = this._sysControls.getPowerProfile();
            const cleanPpLabels = {
                'performance': ['Prestazioni', 'power-profile-performance-symbolic'],
                'balanced': ['Bilanciato', 'power-profile-balanced-symbolic'],
                'power-saver': ['Risparmio', 'power-profile-power-saver-symbolic'],
            };
            const [ppText, ppIcon] = cleanPpLabels[pp.id] ?? [pp.label.replace(/[^\w\sÀ-ÿ-]/g, '').trim(), pp.icon];
            this._qsPower.icon.icon_name = ppIcon;
            this._qsPower.subLbl.text = ppText;
            if (pp.id === 'performance')
                this._qsPower.btn.add_style_class_name('di-qs-toggle-warm');
            else
                this._qsPower.btn.remove_style_class_name('di-qs-toggle-warm');

            if (this._systemSubView)
                this._rebuildSystemSubList();
        } finally {
            this._syncingSliders = false;
        }
    }

    _iconButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'di-btn',
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            child: new St.Icon({icon_name: iconName}),
        });
        button.connect('clicked', () => {
            const {duration} = this._getAnimProfile();
            if (duration > 0) {
                button.remove_all_transitions();
                button.set({scale_x: 0.84, scale_y: 0.84});
                button.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
            callback();
        });
        return button;
    }

    _switchTab(tabId, animate = true) {
        const tabOrder = ['media', 'hub', 'notes', 'file', 'system'];
        const prevIdx = tabOrder.indexOf(this._activeTab);
        const nextIdx = tabOrder.indexOf(tabId);
        const dir = nextIdx >= prevIdx ? 1 : -1;

        const changed = this._activeTab !== tabId;
        this._activeTab = tabId;
        for (const [id, btn] of this._tabButtons.entries()) {
            if (id === tabId)
                btn.add_style_class_name('di-tab-btn-active');
            else
                btn.remove_style_class_name('di-tab-btn-active');
        }
        this._mediaPage.visible = tabId === 'media';
        this._hubPage.visible = tabId === 'hub';
        this._notesPage.visible = tabId === 'notes';
        this._filePage.visible = tabId === 'file';
        this._systemPage.visible = tabId === 'system';

        this._syncHubSampler();
        this._syncMediaPositionSampler();
        if (tabId === 'system')
            this._syncSystemControlsUI();

        const {duration} = this._getAnimProfile();
        if (this._expanded && changed && animate && duration > 0) {
            const page = tabId === 'media'
                ? this._mediaPage
                : tabId === 'hub'
                    ? this._hubPage
                    : tabId === 'notes'
                        ? this._notesPage
                        : tabId === 'file'
                            ? this._filePage
                            : this._systemPage;
            page.remove_all_transitions();
            page.set({opacity: 0, translation_x: dir * 18, translation_y: 0});
            this._refresh();
            page.ease({
                opacity: 255,
                translation_x: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else if (this._expanded) {
            this._refresh();
        }
    }

    // --- QUICK NOTES MANAGEMENT ---
    _loadNotes() {
        try {
            const raw = this._settings.get_string('quick-notes-json');
            const parsed = JSON.parse(raw);
            this._notes = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            this._notes = [];
        }
        this._rebuildNotesUI();
    }

    _saveNotes() {
        try {
            this._settings.set_string('quick-notes-json', JSON.stringify(this._notes));
        } catch (e) {
            // Ignore serialization errors
        }
        this._rebuildNotesUI();
        this._refresh();
    }

    _addNoteFromEntry() {
        const text = this._newNoteEntry.get_text().trim();
        if (!text)
            return;
        this._notes.unshift({
            id: Date.now(),
            text,
            done: false,
            pinned: this._notes.length === 0,
        });
        this._newNoteEntry.set_text('');
        this._saveNotes();
    }

    _rebuildNotesUI() {
        if (!this._notesListBox)
            return;
        this._notesListBox.destroy_all_children();

        const pinnedNote = this._notes.find(n => n.pinned && !n.done);
        if (pinnedNote) {
            this._pinBadgeLabel.text = pinnedNote.text;
            this._pinBadge.visible = true;
        } else {
            this._pinBadge.visible = false;
        }

        if (this._notes.length === 0) {
            this._notesListBox.add_child(new St.Label({
                style_class: 'di-muted-label',
                text: 'Nessuna nota rapida. Scrivi sopra per crearne una.',
            }));
            return;
        }

        for (const note of this._notes.slice(0, 5)) {
            const row = new St.BoxLayout({
                style_class: 'di-note-row',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const checkBtn = new St.Button({
                style_class: 'di-icon-btn',
                child: new St.Icon({
                    icon_name: note.done ? 'object-select-symbolic' : 'checkbox-symbolic',
                    style: 'icon-size: 13px;',
                }),
            });
            checkBtn.connect('clicked', () => {
                note.done = !note.done;
                this._saveNotes();
            });
            row.add_child(checkBtn);

            const lbl = new St.Label({
                style_class: note.done ? 'di-note-done' : 'di-note-text',
                text: note.text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            lbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(lbl);

            const pinBtn = new St.Button({
                style_class: note.pinned ? 'di-icon-btn di-icon-btn-pinned' : 'di-icon-btn',
                child: new St.Icon({icon_name: 'view-pin-symbolic', style: 'icon-size: 13px;'}),
            });
            pinBtn.connect('clicked', () => {
                const targetState = !note.pinned;
                this._notes.forEach(n => {
                    n.pinned = false;
                });
                note.pinned = targetState;
                this._saveNotes();
            });
            row.add_child(pinBtn);

            const copyBtn = new St.Button({
                style_class: 'di-icon-btn',
                child: new St.Icon({icon_name: 'edit-copy-symbolic', style: 'icon-size: 13px;'}),
            });
            copyBtn.connect('clicked', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, note.text);
                this.toast('edit-copy-symbolic', 'Nota copiata negli appunti', {duration: 1300});
            });
            row.add_child(copyBtn);

            const delBtn = new St.Button({
                style_class: 'di-icon-btn',
                child: new St.Icon({icon_name: 'user-trash-symbolic', style: 'icon-size: 13px;'}),
            });
            delBtn.connect('clicked', () => {
                this._notes = this._notes.filter(n => n.id !== note.id);
                this._saveNotes();
            });
            row.add_child(delBtn);

            this._notesListBox.add_child(row);
        }
    }

    // --- POMODORO / TIMER ---
    _toggleTimer() {
        this._timerRunning = !this._timerRunning;
        if (this._timerRunning && this._timerRemaining <= 0)
            this._timerRemaining = 25 * 60;
        this._syncTimerLoop();
        this._updateTimerUI();
        this._refresh();
    }

    _adjustTimer(deltaSecs) {
        this._timerRemaining = Math.max(0, this._timerRemaining + deltaSecs);
        this._updateTimerUI();
        this._refresh();
    }

    _setTimer(secs) {
        this._timerRunning = false;
        this._timerRemaining = secs;
        this._syncTimerLoop();
        this._updateTimerUI();
        this._refresh();
    }

    _syncTimerLoop() {
        if (this._timerTickId) {
            GLib.source_remove(this._timerTickId);
            this._timerTickId = 0;
        }
        if (!this._timerRunning)
            return;
        this._timerTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._timerRemaining > 0) {
                this._timerRemaining--;
                this._updateTimerUI();
                return GLib.SOURCE_CONTINUE;
            }
            this._timerRunning = false;
            this._timerTickId = 0;
            this._updateTimerUI();
            this._refresh();
            this._playTimerSound();
            this.toast('alarm-symbolic', 'Timer completato', {
                color: '#30d158',
                duration: 4000,
                placementGroup: 'alert',
                titleText: 'Timer completato',
                subtitle: 'Conto alla rovescia terminato',
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _playTimerSound() {
        try {
            if (!this._settings.get_boolean('timer-sound'))
                return;
            const player = global.display.get_sound_player();
            if (!player)
                return;
            const alarmPath = '/usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga';
            const bellPath = '/usr/share/sounds/freedesktop/stereo/complete.oga';
            if (GLib.file_test(alarmPath, GLib.FileTest.EXISTS))
                player.play_from_file(Gio.File.new_for_path(alarmPath), 'Timer Dynamic Island completato', null);
            else if (GLib.file_test(bellPath, GLib.FileTest.EXISTS))
                player.play_from_file(Gio.File.new_for_path(bellPath), 'Timer Dynamic Island completato', null);
            else
                player.play_from_theme('alarm-clock-elapsed', 'Timer Dynamic Island completato', null);
        } catch (e) {
            // Ignore audio playback errors
        }
    }

    _updateTimerUI() {
        const text = formatTimer(this._timerRemaining);
        if (this._timerLabel)
            this._timerLabel.text = text;
        if (this._timerToggleBtn)
            this._timerToggleBtn.label = this._timerRunning ? 'Pausa' : 'Avvia';
        if (this._timerBadgeLabel)
            this._timerBadgeLabel.text = text;
        if (this._timerBadge)
            this._timerBadge.visible = this._timerRunning;
    }

    // --- CLOCK, WORKSPACES & ASYNC SYSTEM STATS ---
    _tickIdleClock() {
        const now = GLib.DateTime.new_now_local();
        if (now) {
            const minStr = now.format('%H:%M') ?? '';
            if (minStr !== this._lastMinuteStr) {
                this._lastMinuteStr = minStr;
                this._idleClockLabel.text = minStr;
            }
        }
        return GLib.SOURCE_CONTINUE;
    }

    _syncHubSampler() {
        const shouldRun = this._expanded && this._activeTab === 'hub';
        if (shouldRun && !this._hubStatsId) {
            this._sampleHubNow();
            this._hubStatsId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                if (!this._expanded || this._activeTab !== 'hub') {
                    this._hubStatsId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._sampleHubNow();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!shouldRun && this._hubStatsId) {
            GLib.source_remove(this._hubStatsId);
            this._hubStatsId = 0;
        }
    }

    _sampleHubNow() {
        const now = GLib.DateTime.new_now_local();
        if (now) {
            this._hubClockLabel.text = now.format('%H:%M:%S') ?? '';
            this._hubDateLabel.text = now.format('%a %d %b') ?? '';
        }
        const formatRate = bytesPerSec => {
            if (bytesPerSec >= 1048576)
                return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
            return `${Math.round(bytesPerSec / 1024)} KB/s`;
        };
        if (this._settings.get_boolean('show-system-stats')) {
            this._sysStatsBox.visible = true;
            this._sysStats.sampleAsync(data => {
                if (!this._mCpu)
                    return;
                this._mCpu.valLbl.text = `${data.cpu}%`;
                this._mCpu.subLbl.text = data.cpuTemp ? `${data.cpuTemp}°C` : 'Carico CPU';
                this._pushMetricSample(this._mCpu, data.cpu);

                this._mRam.valLbl.text = `${data.ramPct}%`;
                this._mRam.subLbl.text = `${data.ramUsedGb} / ${data.ramTotalGb} GB`;
                this._pushMetricSample(this._mRam, data.ramPct);

                this._mGpu.valLbl.text = data.gpuLabel;
                this._mGpu.subLbl.text = data.gpuSub || 'Grafica';
                const gpuVal = parseInt(data.gpuLabel, 10);
                this._pushMetricSample(this._mGpu, Number.isFinite(gpuVal) ? gpuVal : 0);

                this._mDisk.valLbl.text = `${data.diskPct}%`;
                this._mDisk.subLbl.text = `${data.diskUsedGb} / ${data.diskTotalGb} GB`;
                this._pushMetricSample(this._mDisk, data.diskPct);

                this._mNet.valLbl.text = `↓ ${formatRate(data.rxRate)}`;
                this._mNet.subLbl.text = `↑ ${formatRate(data.txRate)}`;
                this._pushMetricSample(this._mNet, Math.max(0, (data.rxRate || 0) + (data.txRate || 0)));

                const temps = [];
                if (data.cpuTemp)
                    temps.push(`CPU ${data.cpuTemp}°C`);
                if (data.nvmeTemp)
                    temps.push(`SSD ${data.nvmeTemp}°C`);
                if (data.wifiTemp)
                    temps.push(`Wi-Fi ${data.wifiTemp}°C`);
                this._mTemp.valLbl.text = data.cpuTemp ? `${data.cpuTemp}°C` : '--°C';
                this._mTemp.subLbl.text = temps.slice(1).join(' · ') || 'Sensori attivi';
                const tempNorm = data.cpuTemp ? Math.max(0, Math.min(100, ((data.cpuTemp - 20) / 80) * 100)) : 0;
                this._pushMetricSample(this._mTemp, tempNorm);

                if (data.power?.present) {
                    this._powerPill.remove_style_class_name('di-power-pill-charging');
                    this._powerPill.remove_style_class_name('di-power-pill-discharging');
                    const inW = data.power.status === 'Charging' ? data.power.watts : 0;
                    const outW = data.power.status === 'Discharging' ? data.power.watts : 0;
                    const vStr = data.power.volts > 0 ? `${data.power.volts.toFixed(2)} V` : '-- V';
                    if (data.power.status === 'Charging') {
                        this._powerPill.add_style_class_name('di-power-pill-charging');
                        this._powerIcon.icon_name = 'battery-good-charging-symbolic';
                    } else if (data.power.status === 'Discharging') {
                        this._powerPill.add_style_class_name('di-power-pill-discharging');
                        this._powerIcon.icon_name = 'battery-good-symbolic';
                    } else {
                        this._powerIcon.icon_name = 'ac-adapter-symbolic';
                    }
                    this._powerValLabel.text = `In: +${inW.toFixed(1)} W  ·  Out: -${outW.toFixed(1)} W`;
                    this._powerSubLabel.text = `Tensione: ${vStr}`;
                    this._powerPctLabel.text = `${data.power.capacity}%`;
                    this._powerPctLabel.visible = true;
                } else {
                    this._powerValLabel.text = 'In: -- W  ·  Out: -- W';
                    this._powerSubLabel.text = 'Alimentazione AC (nessuna batteria)';
                    this._powerPctLabel.visible = false;
                }
            });
        } else {
            this._sysStatsBox.visible = false;
        }
    }

    _pushMetricSample(tile, value) {
        if (!tile?.history || !tile?.chart)
            return;
        const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
        tile.history.push(safe);
        if (tile.history.length > 18)
            tile.history.shift();
        tile.chart.queue_repaint();
    }

    _drawMetricChart(area, history, [r, g, b], fixedMax = 100) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        if (!history || history.length < 2 || w <= 2 || h <= 2) {
            cr.$dispose();
            return;
        }

        const maxVal = fixedMax > 0
            ? fixedMax
            : Math.max(1024, ...history) * 1.15;
        const topPad = Math.max(6, Math.round(h * 0.18));
        const usableH = Math.max(4, h - topPad);
        const stepX = w / (history.length - 1);

        const pts = history.map((v, i) => {
            const norm = Math.max(0, Math.min(1, v / maxVal));
            return [i * stepX, h - norm * usableH];
        });

        const traceCurve = () => {
            cr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 0; i < pts.length - 1; i++) {
                const mx = (pts[i][0] + pts[i + 1][0]) / 2;
                const my = (pts[i][1] + pts[i + 1][1]) / 2;
                cr.curveTo(pts[i][0], pts[i][1], pts[i][0], pts[i][1], mx, my);
            }
            cr.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        };

        cr.save();
        roundedRect(cr, 1, 1, Math.max(1, w - 2), Math.max(1, h - 2), 11);
        cr.clip();

        // Soft translucent gradient fill below curve
        traceCurve();
        cr.lineTo(w, h);
        cr.lineTo(0, h);
        cr.closePath();

        const grad = new Cairo.LinearGradient(0, topPad, 0, h);
        grad.addColorStopRGBA(0, r, g, b, 0.24);
        grad.addColorStopRGBA(1, r, g, b, 0.02);
        cr.setSource(grad);
        cr.fill();

        // Crisp translucent trend stroke
        traceCurve();
        cr.setSourceRGBA(r, g, b, 0.45);
        cr.setLineWidth(1.4);
        cr.stroke();

        cr.restore();
        cr.$dispose();
    }

    _syncWorkspaces() {
        if (!this._wsBox)
            return;
        if (!this._settings.get_boolean('show-workspaces')) {
            this._wsButton.visible = false;
            this._lastWsKey = '';
            return;
        }
        const wm = global.workspace_manager;
        const count = Math.max(1, wm.get_n_workspaces());
        const activeIdx = wm.get_active_workspace_index();
        const key = `${count}:${activeIdx}`;
        if (key === this._lastWsKey)
            return;
        this._lastWsKey = key;
        const children = this._wsBox.get_children();

        while (children.length > count) {
            const last = children.pop();
            last.destroy();
        }
        for (let i = 0; i < count; i++) {
            const isActive = i === activeIdx;
            const cls = isActive ? 'di-ws-dot-active' : 'di-ws-dot';
            if (i < children.length) {
                const wasActive = children[i].style_class === 'di-ws-dot-active';
                children[i].style_class = cls;
                if (isActive && !wasActive) {
                    children[i].set_pivot_point(0.5, 0.5);
                    children[i].set({scale_x: 1.35, scale_y: 1.15});
                    children[i].ease({
                        scale_x: 1,
                        scale_y: 1,
                        duration: 240,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    });
                }
            } else {
                this._wsBox.add_child(new St.Widget({
                    style_class: cls,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }
        }
    }

    _onScroll(event) {
        if (this._expanded)
            return Clutter.EVENT_PROPAGATE;
        const dir = event.get_scroll_direction();
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace_index();
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT) {
            const target = wm.get_workspace_by_index(Math.max(0, active - 1));
            target?.activate(global.get_current_time());
            return Clutter.EVENT_STOP;
        } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT) {
            const target = wm.get_workspace_by_index(Math.min(wm.get_n_workspaces() - 1, active + 1));
            target?.activate(global.get_current_time());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // --- TOP BAR REPLACEMENT & CLOCK VISIBILITY ---
    _isTopBarHidden() {
        try {
            return this._settings.get_boolean('hide-top-bar');
        } catch (e) {
            return true;
        }
    }

    _syncTopBarVisibility() {
        const hideBar = this._isTopBarHidden();
        const panelBox = Main.layoutManager.panelBox;
        const panel = Main.panel;

        panelBox?.disconnectObject(this);
        panel?.disconnectObject(this);

        if (hideBar) {
            if (panel) {
                panel.visible = false;
                panel.connectObject('notify::visible', () => {
                    if (this._isTopBarHidden() && panel.visible)
                        panel.visible = false;
                }, this);
            }
            if (panelBox) {
                panelBox.height = 0;
                panelBox.visible = false;
                panelBox.connectObject('notify::visible', () => {
                    if (this._isTopBarHidden() && panelBox.visible) {
                        panelBox.height = 0;
                        panelBox.visible = false;
                        Main.layoutManager._queueUpdateRegions?.();
                    }
                }, this);
            }
            Main.layoutManager._queueUpdateRegions?.();
        } else {
            if (panelBox) {
                panelBox.height = -1;
                panelBox.visible = true;
            }
            if (panel)
                panel.visible = true;
            Main.layoutManager._queueUpdateRegions?.();
        }

        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu && !hideBar) {
            const pos = this._settings.get_string('position');
            const isCenter = ['notch-top', 'top-center', 'panel-center'].includes(pos);
            const shouldHide = isCenter && this._settings.get_boolean('hide-panel-clock');
            dateMenu.container.visible = !shouldHide;
        }
    }

    _onDestroy() {
        this._destroyed = true;
        this._stopEqLoop();
        this._fileShelf?.destroy();
        this._fileShelf = null;
        this._sysStats?.destroy();
        this._sysStats = null;
        this._sysControls?.destroy();
        this._sysControls = null;
        this._eqGrad = null;
        if (this._unredirectDisabled) {
            try {
                global.compositor.enable_unredirect();
            } catch (e) {
                // Ignore
            }
            this._unredirectDisabled = false;
        }
        if (this._idleClockId) {
            GLib.source_remove(this._idleClockId);
            this._idleClockId = 0;
        }
        if (this._hubStatsId) {
            GLib.source_remove(this._hubStatsId);
            this._hubStatsId = 0;
        }
        if (this._timerTickId) {
            GLib.source_remove(this._timerTickId);
            this._timerTickId = 0;
        }
        if (this._toastId)
            GLib.source_remove(this._toastId);
        if (this._belowToastId) {
            GLib.source_remove(this._belowToastId);
            this._belowToastId = 0;
        }
        if (this._mediaPosId) {
            GLib.source_remove(this._mediaPosId);
            this._mediaPosId = 0;
        }
        if (this._mediaSeekCommitId) {
            GLib.source_remove(this._mediaSeekCommitId);
            this._mediaSeekCommitId = 0;
        }
        if (this._belowToast) {
            this._belowToast.remove_all_transitions();
            this._belowToast.destroy();
            this._belowToast = null;
        }
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        if (this._hoverWatchId) {
            GLib.source_remove(this._hoverWatchId);
            this._hoverWatchId = 0;
        }
        if (this._dodgeCheckId) {
            GLib.source_remove(this._dodgeCheckId);
            this._dodgeCheckId = 0;
        }
        this._focusedWin?.disconnectObject(this);
        this._focusedWin = null;
        this.remove_all_transitions();
        this._artCancellable.cancel();
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.panel.statusArea.dateMenu?.container.disconnectObject(this);
        Main.panel.statusArea.dateMenu?.disconnectObject(this);
        Main.panel.statusArea.dateMenu?.menu.disconnectObject(this);
        Main.layoutManager.panelBox?.disconnectObject(this);
        Main.panel?.disconnectObject(this);
        if (Main.layoutManager.panelBox) {
            Main.layoutManager.panelBox.height = -1;
            Main.layoutManager.panelBox.visible = true;
        }
        if (Main.panel)
            Main.panel.visible = true;
        Main.layoutManager._queueUpdateRegions?.();
        if (Main.panel.statusArea.dateMenu?.container)
            Main.panel.statusArea.dateMenu.container.visible = true;
    }

    destroy() {
        const slot = this._slot;
        this._slot = null;
        super.destroy();
        slot?.destroy();
    }

    _effectivePosition() {
        const raw = this._settings.get_string('position');
        if (this._isTopBarHidden() && PANEL_SLOTS[raw])
            return 'notch-top';
        return raw;
    }

    _isPanelNotch() {
        return !!this._slot && this._position === 'panel-notch' && !!Main.panel.statusArea.dateMenu;
    }

    _isTopEdgeNotch() {
        return this._position === 'notch-top';
    }

    _expandedGeometry() {
        if (this._isTopEdgeNotch())
            return this._layouts.expandedTopNotch;
        if (!this._isPanelNotch())
            return this._layouts.expanded;
        const panelH = Main.panel.height;
        if (!this._layouts.expandedPanel || this._layouts.expandedPanelPanelH !== panelH) {
            const expanded = this._layouts.expanded;
            const padding = [...expanded.padding];
            padding[0] += panelH;
            this._layouts.expandedPanel = {...expanded, padding, topRadius: 0};
            this._layouts.expandedPanelPanelH = panelH;
        }
        return this._layouts.expandedPanel;
    }

    _compact() {
        if (this._isDodged()) {
            const notch = this._isTopEdgeNotch();
            if (this._dodgeMode() === 'peek-bar')
                return notch ? this._layouts.peekBarNotch : this._layouts.peekBar;
            return notch ? this._layouts.slimClockNotch : this._layouts.slimClock;
        }
        if (this._slot)
            return this._layouts.panelCompact;
        return this._isTopEdgeNotch() ? this._layouts.compactNotch : this._layouts.compact;
    }

    _dodgeMode() {
        try {
            return this._settings.get_string('auto-dodge');
        } catch (e) {
            return 'slim-clock';
        }
    }

    _isDodged() {
        if (this._slot || this._expanded || this._toastActive || this._dragOpening)
            return false;
        if (Main.overview?.visible)
            return false;
        if (this._position !== 'notch-top' && this._position !== 'top-center')
            return false;
        if (this._dodgeMode() === 'off' || !this._topCovered)
            return false;
        if (this._dodgeMode() === 'peek-bar' && this.hover && this._settings.get_string('expand-on') === 'click')
            return false;
        return true;
    }

    _trackFocusedWindow() {
        this._focusedWin?.disconnectObject(this);
        const win = global.display.focus_window;
        this._focusedWin = win || null;
        if (!win)
            return;
        win.connectObject(
            'size-changed', () => this._scheduleDodgeCheck(),
            'position-changed', () => this._scheduleDodgeCheck(),
            'notify::minimized', () => this._scheduleDodgeCheck(),
            this
        );
    }

    _scheduleDodgeCheck() {
        if (this._destroyed)
            return;
        if (this._dodgeCheckId)
            GLib.source_remove(this._dodgeCheckId);
        this._dodgeCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._dodgeCheckId = 0;
            if (this._checkAutoDodge())
                this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkAutoDodge() {
        let covered = false;
        const canDodge = !this._slot &&
            (this._position === 'notch-top' || this._position === 'top-center') &&
            this._dodgeMode() !== 'off';

        if (canDodge) {
            const monitor = Main.layoutManager.primaryMonitor;
            const primaryIdx = Main.layoutManager.primaryIndex;
            const ws = global.workspace_manager.get_active_workspace();
            if (monitor && ws) {
                const center = monitor.x + Math.floor(monitor.width / 2);
                const zoneLeft = center - 180;
                const zoneRight = center + 180;
                const topOffset = this._isTopBarHidden() ? 0 : Main.panel.height;
                const zoneBottom = monitor.y + topOffset + 42;

                for (const win of ws.list_windows()) {
                    if (win.minimized || !win.showing_on_its_workspace())
                        continue;
                    if (win.get_monitor() !== primaryIdx)
                        continue;
                    if (win.window_type !== Meta.WindowType.NORMAL)
                        continue;
                    const title = win.get_title() ?? '';
                    if (title.startsWith('DI-DropCatcher-'))
                        continue;
                    if (win.is_fullscreen() || win.maximized_vertically) {
                        covered = true;
                        break;
                    }
                    const rect = win.get_frame_rect();
                    if (rect.y < zoneBottom && rect.x < zoneRight && (rect.x + rect.width) > zoneLeft) {
                        covered = true;
                        break;
                    }
                }
            }
        }

        const changed = covered !== this._topCovered;
        this._topCovered = covered;
        return changed;
    }

    _updateLayouts() {
        this._layouts = buildLayouts(this._settings);
        this._updateStaticStyles();
        this._refresh();
    }

    _updateStaticStyles() {
        const px = v => `${Math.max(0, Math.round(v))}px`;
        const maxTextW = this._settings.get_int('text-width');
        this._compactTitle.style = `max-width: ${maxTextW}px;`;
        this._text.style = `max-width: ${maxTextW + 40}px; spacing: 2px;`;

        const smallArt = Math.round(this._layouts.compact.artSize);
        const bigArt = Math.round(this._layouts.expanded.artSize);
        this._art.set_size(smallArt, smallArt);
        this._expandedArt.set_size(bigArt, bigArt);

        const border = ART_BORDER[this._settings.get_string('art-border')]?.(this._settings);
        const borderCss = border ? ` border: ${border};` : '';
        this._art.style = `${this._artBackground} border-radius: ${px(this._layouts.compact.artRadius)};${borderCss}`;
        this._expandedArt.style = `${this._artBackground} border-radius: ${px(this._layouts.expanded.artRadius)};${borderCss}`;
    }

    _playerStatus() {
        return this._player?._playerProxy ? this._player.status : 'Stopped';
    }

    _syncSpin() {
        const enabled = this._settings.get_boolean('art-spin');
        const spin = enabled && this._hasMusic && this._playerStatus() === 'Playing' && !this._expanded;
        if (spin === !!this._art.get_transition('di-spin'))
            return;
        if (spin) {
            const angle = this._art.rotation_angle_z % 360;
            const transition = new Clutter.PropertyTransition({
                property_name: 'rotation-angle-z',
                duration: 8000,
                repeat_count: -1,
                progress_mode: Clutter.AnimationMode.LINEAR,
            });
            transition.set_from(angle);
            transition.set_to(angle + 360);
            this._art.add_transition('di-spin', transition);
        } else {
            this._art.remove_transition('di-spin');
            if (!enabled)
                this._art.rotation_angle_z = 0;
        }
    }

    _place() {
        const position = this._effectivePosition();
        if (position === this._position)
            return;
        this._position = position;

        if (this._isTopEdgeNotch())
            this.add_style_class_name('di-island-notch');
        else
            this.remove_style_class_name('di-island-notch');

        Main.panel.statusArea.dateMenu?.container.disconnectObject(this);
        Main.panel.statusArea.dateMenu?.disconnectObject(this);
        Main.panel.statusArea.dateMenu?.menu.disconnectObject(this);

        if (this._slot) {
            this._slot.remove_child(this);
            this._slot.destroy();
            this._slot = null;
        } else if (this.get_parent()) {
            Main.layoutManager.removeChrome(this);
        }

        const target = PANEL_SLOTS[position];
        if (target) {
            this._slot = new St.Widget({width: 0});
            this._slot.connect('notify::width', () => {
                if (!this._morphing)
                    this._reposition();
            });
            Main.panel[target[0]].insert_child_at_index(this._slot, target[1]);
            this._slot.add_child(this);
            if (this._isPanelNotch()) {
                const clock = Main.panel.statusArea.dateMenu.container;
                const sync = () => {
                    this._notch.width = clock.width;
                    if (!this._morphing)
                        this._reposition();
                };
                clock.connectObject('notify::width', sync, 'notify::x', sync, this);
                const dateMenu = Main.panel.statusArea.dateMenu;
                dateMenu.connectObject('notify::hover', () => this._onHover(), this);
                dateMenu.menu.connectObject('open-state-changed', () => this._onHover(), this);
                sync();
            }
        } else {
            Main.layoutManager.addTopChrome(this, {trackFullscreen: false});
            this._raiseToTop();
        }

        if (this._shown) {
            this.remove_all_transitions();
            this.set({opacity: 255, scale_x: 1, scale_y: 1});
        }
        this._refresh();
    }

    _fitSlot() {
        if (this._slot && !this._layout.expanded && !this._isPanelNotch()) {
            const {duration, mode} = this._getAnimProfile();
            this._slot.ease({width: this._shown ? this._restWidth : 0, duration, mode});
        }
    }

    _openDefaultOrLastTab() {
        let alwaysFixed = true;
        try {
            alwaysFixed = this._settings.get_boolean('always-open-default-tab');
        } catch (e) {
            alwaysFixed = true;
        }
        if (!alwaysFixed)
            return;

        const defTab = this._settings.get_string('default-tab');
        const target = defTab === 'auto'
            ? (this._hasMusic ? 'media' : 'system')
            : defTab;
        const valid = ['media', 'hub', 'notes', 'file', 'system'];
        this._switchTab(valid.includes(target) ? target : 'media', false);
    }

    vfunc_button_release_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (!this._expanded) {
            this._openDefaultOrLastTab();
            this._setExpanded(true);
            return Clutter.EVENT_STOP;
        }
        // Fitts's Law: if pointer is slammed at the very top edge (y <= 34), match tab button by X coordinate
        const [px, py] = event.get_coords();
        const [, iy] = this.get_transformed_position();
        if (py - iy <= 34) {
            for (const [id, btn] of this._tabButtons.entries()) {
                const [bx] = btn.get_transformed_position();
                const [bw] = btn.get_transformed_size();
                if (px >= bx && px <= bx + bw) {
                    this._switchTab(id, true);
                    return Clutter.EVENT_STOP;
                }
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    setPlayer(player, source) {
        if (this._destroyed)
            return;
        this._player = player;
        const status = this._playerStatus();
        this._hasMusic = !!player && !!player.trackTitle && status !== 'Stopped';
        if (this._hasMusic) {
            this._playButton.child.icon_name = status === 'Playing'
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
            this._sourceIcon.gicon = toGicon(source.icon);
            this._sourceLabel.text = source.name;
            this._source.visible = !!source.name;

            const meta = player._playerProxy?.Metadata;
            const rawLen = meta?.['mpris:length']?.deepUnpack?.() ?? 0;
            this._mediaLengthUs = Number(rawLen) > 0 ? Number(rawLen) : 0;
            this._mediaTrackId = meta?.['mpris:trackid']?.deepUnpack?.() ?? null;
            this._mediaCanSeek = player._playerProxy?.CanSeek ?? true;
            this._mediaSeekRow.visible = this._mediaLengthUs > 0;
            this._mediaSeekSlider.reactive = !!this._mediaCanSeek;
            if (this._mediaLengthUs > 0)
                this._mediaDurLabel.text = this._formatMediaTime(this._mediaLengthUs);

            const key = `${player.trackTitle}\n${player.trackArtists.join(', ')}\n${player.trackCoverUrl}`;
            if (key !== this._trackKey) {
                this._trackKey = key;
                this._mediaPosUs = 0;
                this._applyMediaSliderPos(0);
                this._swapTrack(player);
            }
        } else {
            this._trackKey = null;
            this._mediaLengthUs = 0;
            this._mediaPosUs = 0;
            this._mediaTrackId = null;
            this._mediaSeekRow.visible = false;
            this._title.text = 'Nessun media in riproduzione';
            this._artist.text = 'Apri Spotify, browser o un player MPRIS';
            this._source.visible = false;
            this._setArtBackground(null);
        }
        this._refresh();
        this._syncMediaPositionSampler();
        this._syncSpin();
        this._syncEqState();
    }

    _formatMediaTime(us) {
        const totalSec = Math.max(0, Math.floor((us || 0) / 1000000));
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0)
            return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    _applyMediaSliderPos(posUs) {
        if (!this._mediaSeekSlider || this._mediaDragging || this._mediaLengthUs <= 0)
            return;
        const clamped = Math.max(0, Math.min(this._mediaLengthUs, posUs));
        this._syncingMediaSlider = true;
        try {
            this._mediaSeekSlider.value = clamped / this._mediaLengthUs;
            this._mediaCurLabel.text = this._formatMediaTime(clamped);
        } finally {
            this._syncingMediaSlider = false;
        }
    }

    _syncMediaPositionSampler() {
        const shouldRun = !this._destroyed && this._expanded && this._activeTab === 'media' &&
            this._hasMusic && !this._toastActive && this._mediaLengthUs > 0;
        if (shouldRun && !this._mediaPosId) {
            this._pollMediaPosition();
            this._mediaPosId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                if (this._destroyed || !this._expanded || this._activeTab !== 'media' ||
                    !this._hasMusic || this._mediaLengthUs <= 0) {
                    this._mediaPosId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._pollMediaPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!shouldRun && this._mediaPosId) {
            GLib.source_remove(this._mediaPosId);
            this._mediaPosId = 0;
        }
    }

    _pollMediaPosition() {
        const player = this._player;
        const busName = player?._playerProxy?.g_name;
        const objPath = player?._playerProxy?.g_object_path || '/org/mpris/MediaPlayer2';
        if (!busName || this._mediaDragging)
            return;
        Gio.DBus.session.call(
            busName,
            objPath,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    const [inner] = conn.call_finish(res).deepUnpack();
                    const posUs = Number(inner?.deepUnpack ? inner.deepUnpack() : inner);
                    if (this._destroyed || this._player !== player || !Number.isFinite(posUs))
                        return;
                    this._mediaPosUs = posUs;
                    this._applyMediaSliderPos(posUs);
                } catch (e) {
                    // Ignore players that don't expose Position
                }
            }
        );
    }

    _commitMediaSeek(fraction) {
        const player = this._player;
        const busName = player?._playerProxy?.g_name;
        const objPath = player?._playerProxy?.g_object_path || '/org/mpris/MediaPlayer2';
        if (!busName || this._mediaLengthUs <= 0 || !this._mediaCanSeek)
            return;

        const targetUs = Math.round(Math.max(0, Math.min(1, fraction)) * this._mediaLengthUs);
        const prevPosUs = this._mediaPosUs;
        this._mediaPosUs = targetUs;

        const fallbackSeek = () => {
            const offsetUs = targetUs - prevPosUs;
            Gio.DBus.session.call(
                busName,
                objPath,
                'org.mpris.MediaPlayer2.Player',
                'Seek',
                new GLib.Variant('(x)', [offsetUs]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        };

        if (typeof this._mediaTrackId === 'string' && this._mediaTrackId.startsWith('/')) {
            Gio.DBus.session.call(
                busName,
                objPath,
                'org.mpris.MediaPlayer2.Player',
                'SetPosition',
                new GLib.Variant('(ox)', [this._mediaTrackId, targetUs]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        fallbackSeek();
                    }
                }
            );
        } else {
            fallbackSeek();
        }
    }

    showNotification(notif) {
        if (this._destroyed)
            return;
        const entry = {...notif, id: Date.now() + Math.random()};
        this._notifications.unshift(entry);
        if (this._notifications.length > 25)
            this._notifications.pop();
        this._rebuildNotificationsUI();
        this._refresh();
    }

    clearNotifications() {
        this._notifications = [];
        this._rebuildNotificationsUI();
        this._refresh();
    }

    _rebuildNotificationsUI() {
        if (!this._notifListBox)
            return;
        this._notifListBox.destroy_all_children();

        const count = this._notifications.length;
        this._notifHeaderLabel.text = `NOTIFICHE (${count})`;
        this._notifBadgeLabel.text = `${count}`;
        this._notifBadge.visible = count > 0;
        this._notifSection.visible = count > 0;

        for (const notif of this._notifications) {
            const item = new St.Button({
                style_class: 'di-notif-item',
                x_expand: true,
            });
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style: 'spacing: 9px;',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(new St.Icon({
                gicon: toGicon(notif.icon),
                style: 'icon-size: 18px; color: #b8b6ff;',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const textCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const titleLbl = new St.Label({style_class: 'di-title', text: notif.title});
            const bodyLbl = new St.Label({
                style_class: 'di-artist',
                text: notif.body || notif.sourceName || 'Notifica',
            });
            titleLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            bodyLbl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(titleLbl);
            textCol.add_child(bodyLbl);
            row.add_child(textCol);

            const dismissBtn = new St.Button({
                style_class: 'di-icon-btn',
                child: new St.Icon({icon_name: 'window-close-symbolic', style: 'icon-size: 12px;'}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            dismissBtn.connect('clicked', () => {
                this._notifications = this._notifications.filter(n => n.id !== notif.id);
                this._rebuildNotificationsUI();
                this._refresh();
                return Clutter.EVENT_STOP;
            });
            row.add_child(dismissBtn);

            item.set_child(row);
            item.connect('clicked', () => {
                notif.onActivate?.();
                this._notifications = this._notifications.filter(n => n.id !== notif.id);
                this._rebuildNotificationsUI();
                this._refresh();
            });

            this._notifListBox.add_child(item);
        }
    }

    toast(icon, text, {level = null, color = null, duration = 2200, placementGroup = null, titleText = null, subtitle = null, onActivate = null} = {}) {
        let toastPos = 'inside';
        if (placementGroup === 'alert') {
            try {
                toastPos = this._settings.get_string('toast-position');
            } catch (e) {
                toastPos = 'inside';
            }
        }
        if (toastPos === 'below') {
            this._showBelowToast(icon, titleText || text, subtitle, {color, duration, onActivate});
            return;
        }

        this._toastIcon.gicon = toGicon(icon);
        this._toastIcon.style = color ? `color: ${color};` : null;
        this._toastLabel.text = text;
        this._toastLabel.visible = !!text;
        this._toastBar.visible = level !== null;
        if (level !== null) {
            this._toastFill.ease({
                width: Math.round(BAR_W * Math.max(0, Math.min(level, 1))),
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        const wasActive = this._toastActive;
        this._toastActive = true;
        if (this._toastId)
            GLib.source_remove(this._toastId);
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            this._toastId = 0;
            this._toastActive = false;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
        this._refresh();
        if (!wasActive) {
            const {duration: animDur} = this._getAnimProfile();
            if (animDur > 0) {
                this._toastBox.remove_all_transitions();
                this._toastBox.opacity = 0;
                this._toastBox.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

                this._toastIcon.remove_all_transitions();
                this._toastIcon.set_pivot_point(0.5, 0.5);
                this._toastIcon.set({scale_x: 0.45, scale_y: 0.45});
                this._toastIcon.ease({
                    scale_x: 1,
                    scale_y: 1,
                    duration: 320,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            }
        }
    }

    _ensureBelowToast() {
        if (this._belowToast)
            return this._belowToast;

        const btn = new St.Button({
            style_class: 'di-below-toast',
            reactive: true,
            visible: false,
            can_focus: false,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
            offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
        });
        const row = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style: 'spacing: 10px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._belowToastIcon = new St.Icon({
            style_class: 'di-toast-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const textCol = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style: 'spacing: 1px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._belowToastTitle = new St.Label({
            style_class: 'di-below-toast-title',
        });
        this._belowToastTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._belowToastSub = new St.Label({
            style_class: 'di-below-toast-sub',
        });
        this._belowToastSub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textCol.add_child(this._belowToastTitle);
        textCol.add_child(this._belowToastSub);

        row.add_child(this._belowToastIcon);
        row.add_child(textCol);
        btn.set_child(row);

        btn.connect('clicked', () => {
            const action = this._belowToastAction;
            this._belowToastAction = null;
            this._hideBelowToast(false);
            action?.();
        });

        Main.layoutManager.addTopChrome(btn, {trackFullscreen: false});
        this._belowToast = btn;
        return btn;
    }

    _showBelowToast(icon, title, subtitle, {color = null, duration = 3500, onActivate = null} = {}) {
        if (this._destroyed)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const box = this._ensureBelowToast();
        this._belowToastAction = onActivate;
        this._belowToastIcon.gicon = toGicon(icon);
        this._belowToastIcon.style = color ? `color: ${color};` : null;
        this._belowToastTitle.text = title || '';
        this._belowToastSub.text = subtitle || '';
        this._belowToastSub.visible = !!subtitle;

        const wasVisible = box.visible;
        box.remove_all_transitions();
        box.set({scale_x: 1, scale_y: 1, translation_y: 0, opacity: 255});
        box.show();
        if (box.get_parent() === Main.uiGroup)
            Main.uiGroup.set_child_above_sibling(box, null);

        const [, natW] = box.get_preferred_width(-1);
        const w = Math.round(natW);
        const [, natH] = box.get_preferred_height(w);
        const h = Math.round(natH);

        const centerX = this._shown && this.visible
            ? (this._targetX ?? this.x) + Math.round((this._targetW ?? this.width) / 2)
            : monitor.x + Math.floor(monitor.width / 2);
        const x = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - w - 8, centerX - Math.floor(w / 2)));

        let y;
        if (this._shown && this.visible) {
            const baseY = (this._targetY ?? this.y) + (this._targetH ?? this.height);
            y = this._position === 'bottom-center'
                ? Math.max(monitor.y + 8, (this._targetY ?? this.y) - h - 8)
                : baseY + 8;
        } else {
            const topOffset = this._isTopBarHidden() ? 8 : Main.panel.height + 8;
            y = monitor.y + topOffset;
        }
        box.set_position(x, y);

        if (this._belowToastId)
            GLib.source_remove(this._belowToastId);
        this._belowToastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            this._belowToastId = 0;
            this._hideBelowToast(false);
            return GLib.SOURCE_REMOVE;
        });

        this._syncShelfTrayVisibility();

        const {duration: animDur} = this._getAnimProfile();
        if (!wasVisible && animDur > 0) {
            box.set({opacity: 0, translation_y: -10, scale_x: 0.9, scale_y: 0.9});
            box.ease({
                opacity: 255,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                duration: Math.min(260, Math.max(180, animDur)),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    }

    _hideBelowToast(immediate = false) {
        if (this._belowToastId) {
            GLib.source_remove(this._belowToastId);
            this._belowToastId = 0;
        }
        this._belowToastAction = null;
        const box = this._belowToast;
        if (!box || !box.visible)
            return;

        box.remove_all_transitions();
        const {duration: animDur} = this._getAnimProfile();
        if (immediate || animDur === 0) {
            box.hide();
            this._syncShelfTrayVisibility();
            return;
        }
        box.ease({
            opacity: 0,
            translation_y: -8,
            scale_x: 0.94,
            scale_y: 0.94,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._destroyed)
                    return;
                box.hide();
                box.set({opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1});
                this._syncShelfTrayVisibility();
            },
        });
    }

    setIndicator(key, opts) {
        let chip = this._indicators.get(key);
        if (!opts) {
            if (chip) {
                chip.destroy();
                this._indicators.delete(key);
                this._refresh();
            }
            return;
        }
        const added = !chip;
        if (added) {
            chip = new St.Button({style_class: 'di-chip', can_focus: false, reactive: !!opts.onClick});
            chip.set_child(new St.BoxLayout({
                style_class: 'di-chip-box',
                orientation: Clutter.Orientation.HORIZONTAL,
            }));
            chip.child.add_child(new St.Icon({style_class: 'di-chip-icon'}));
            chip.child.add_child(new St.Label({style_class: 'di-chip-label', y_align: Clutter.ActorAlign.CENTER}));
            if (opts.onClick)
                chip.connect('clicked', opts.onClick);
            this._indicatorBox.add_child(chip);
            this._indicators.set(key, chip);
        }
        const [icon, label] = chip.child.get_children();
        icon.gicon = toGicon(opts.icon);
        icon.style = opts.color ? `color: ${opts.color};` : null;
        label.text = opts.text ?? '';
        label.visible = !!opts.text;
        if (added)
            this._refresh();
    }

    _refresh() {
        if (this._destroyed)
            return;
        const hasIndicators = this._indicators.size > 0;
        const idleMode = this._settings.get_string('idle-mode');
        const hasPinnedNote = this._notes?.some(n => n.pinned && !n.done);
        const showIdle = idleMode !== 'hidden' || this._isTopBarHidden();
        let showCompactStatus = true;
        try {
            showCompactStatus = this._settings.get_boolean('show-compact-status');
        } catch (e) {
            showCompactStatus = true;
        }

        this._morph(() => {
            const expanded = this._expanded && !this._toastActive;
            const dodged = this._isDodged();
            const dodgeMode = this._dodgeMode();
            const peekBar = dodged && dodgeMode === 'peek-bar';
            const slimClock = dodged && dodgeMode !== 'peek-bar';
            const music = this._hasMusic && !this._toastActive && !expanded && !dodged;
            const notch = this._isPanelNotch() && !expanded;

            this._compactRow.visible = !expanded;
            this._compactRow.style = dodged ? 'spacing: 4px;' : 'spacing: 8px;';
            this._expandedRoot.visible = expanded;

            const showWs = !dodged && this._settings.get_boolean('show-workspaces') &&
                !this._toastActive &&
                (idleMode === 'pill-clock-ws' || idleMode === 'workspace-only');
            const showClock = !peekBar && !this._toastActive &&
                (idleMode === 'pill-clock-ws' || idleMode === 'clock-only' || this._isTopBarHidden());

            this._dodgeBar.visible = peekBar;
            this._dodgeMusicDot.visible = slimClock && this._hasMusic;
            this._wsButton.visible = showWs;
            this._idleClockLabel.visible = showClock;
            if (slimClock) {
                this._idleClockLabel.remove_style_class_name('di-idle-clock');
                this._idleClockLabel.add_style_class_name('di-idle-clock-slim');
            } else {
                this._idleClockLabel.remove_style_class_name('di-idle-clock-slim');
                this._idleClockLabel.add_style_class_name('di-idle-clock');
            }
            this._notch.visible = notch;

            this._art.visible = music && this._settings.get_boolean('art-compact');
            this._compactTitle.visible = music && !notch;
            this._eq.visible = music;

            this._timerBadge.visible = !peekBar && !this._toastActive && this._timerRunning;
            this._pinBadge.visible = !dodged && !this._toastActive && !!hasPinnedNote;
            this._notifBadge.visible = !peekBar && !this._toastActive && (this._notifications?.length > 0);
            this._shelfBadge.visible = !peekBar && !this._toastActive && (this._shelfFiles?.length > 0);
            this._indicatorBox.visible = !dodged && !this._toastActive && hasIndicators;
            this._statusPill.visible = !dodged && !this._toastActive && showCompactStatus;
            this._toastBox.visible = this._toastActive;
        });

        const shouldShow = showIdle || this._hasMusic || hasIndicators ||
            this._toastActive || this._timerRunning || hasPinnedNote || this._expanded;
        this._setShown(shouldShow);
        this._syncEqState();
        this._syncSpin();
        this._fitSlot();
        this._syncShelfTrayVisibility();
    }

    _setShown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        const {duration, mode} = this._getAnimProfile();
        if (shown) {
            this.show();
            this._raiseToTop();
            if (duration === 0) {
                this.set({opacity: 255, scale_x: 1, scale_y: 1});
                return;
            }
            this.set({opacity: 0, scale_x: 0.82, scale_y: 0.82});
            this.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration,
                mode,
            });
        } else {
            if (duration === 0) {
                this.hide();
                return;
            }
            this.ease({
                opacity: 0,
                scale_x: 0.82,
                scale_y: 0.82,
                duration: Math.min(180, duration),
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this.hide(),
            });
        }
    }

    _hasEntryFocus() {
        const focus = global.stage.get_key_focus();
        if (!focus)
            return false;
        return this.contains(focus);
    }

    _isPointerInside() {
        if (!this.visible)
            return false;
        if (this.hover)
            return true;
        const [px, py] = global.get_pointer();
        const ax = this._targetX ?? this.x;
        const ay = this._targetY ?? this.y;
        const aw = Math.max(this.width, this._targetW ?? 0);
        const ah = Math.max(this.height, this._targetH ?? 0);
        if (aw <= 0 || ah <= 0)
            return this.hover;
        const pad = this._expanded ? 18 : 6;
        return px >= ax - pad && px <= ax + aw + pad &&
               py >= ay - pad && py <= ay + ah + pad;
    }

    _startHoverWatch() {
        this._outsideTicks = 0;
        if (this._hoverWatchId)
            return;
        this._hoverWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            if (!this._expanded) {
                this._hoverWatchId = 0;
                return GLib.SOURCE_REMOVE;
            }
            // Grace period of 400ms after opening so transition layout changes never close the island
            if (GLib.get_monotonic_time() - this._expandTimestamp < 400000)
                return GLib.SOURCE_CONTINUE;

            if (this._hasEntryFocus() || this._isPointerInside() || this._dragOpening) {
                this._outsideTicks = 0;
                return GLib.SOURCE_CONTINUE;
            }

            this._outsideTicks++;
            if (this._outsideTicks < 2)
                return GLib.SOURCE_CONTINUE;

            this._hoverWatchId = 0;
            this._setExpanded(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopHoverWatch() {
        this._outsideTicks = 0;
        if (this._hoverWatchId) {
            GLib.source_remove(this._hoverWatchId);
            this._hoverWatchId = 0;
        }
    }

    _onHover() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = 0;

        const dateMenu = Main.panel.statusArea.dateMenu;
        const rawHover = this._isPanelNotch()
            ? (this.hover || dateMenu.hover) && !dateMenu.menu.isOpen
            : this.hover;

        // When already expanded, _startHoverWatch handles closing cleanly after the grace period
        if (this._expanded) {
            if (rawHover)
                this._outsideTicks = 0;
            return;
        }

        if (!rawHover || this._settings.get_string('expand-on') === 'click') {
            if (this._dodgeMode() === 'peek-bar' && this._topCovered)
                this._refresh();
            return;
        }

        // Subtle tactile hover-anticipation lift on compact pill before expansion
        const {duration} = this._getAnimProfile();
        if (duration > 0 && !this._morphing) {
            this.ease({
                scale_x: 1.03,
                scale_y: 1.03,
                duration: 60,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 65, () => {
            this._hoverId = 0;
            this.set({scale_x: 1, scale_y: 1});
            if (!this.hover && !this._isPointerInside())
                return GLib.SOURCE_REMOVE;
            this._openDefaultOrLastTab();
            this._setExpanded(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setExpanded(expanded) {
        if (expanded === this._expanded)
            return;
        this._expanded = expanded;
        if (expanded) {
            this._expandTimestamp = GLib.get_monotonic_time();
            this._raiseToTop();
            this._startHoverWatch();
        } else {
            this._stopHoverWatch();
        }

        if (!expanded && this._hasEntryFocus())
            global.stage.set_key_focus(null);

        this._syncHubSampler();
        this._syncMediaPositionSampler();
        if (expanded && this._activeTab === 'system')
            this._syncSystemControlsUI();
        this._refresh();

        const activeChild = expanded ? this._expandedRoot : this._compactRow;
        const {duration} = this._getAnimProfile();
        if (duration > 0 && activeChild.visible) {
            activeChild.remove_all_transitions();
            activeChild.set({opacity: 0, translation_y: expanded ? -4 : 3});
            activeChild.ease({
                opacity: 255,
                translation_y: 0,
                duration: Math.min(180, duration),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    _computeTargetPosition(width, height) {
        if (this._isPanelNotch()) {
            const clock = Main.panel.statusArea.dateMenu.container;
            const anchor = this._notch.visible ? this._notch.x + this._notch.width / 2 : width / 2;
            return [
                Math.round(clock.x + clock.width / 2 - this._slot.x - anchor),
                Math.max(0, Math.round((Main.panel.height - height) / 2)),
            ];
        }
        if (this._slot) {
            const grow = PANEL_SLOTS[this._position][2] ?? 0;
            return [
                Math.round((this._slot.width - width) * grow),
                Math.max(0, Math.round((Main.panel.height - height) / 2)),
            ];
        }
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return [this.x, this.y];
        const pos = this._position;
        if (pos === 'notch-top') {
            return [
                monitor.x + Math.floor((monitor.width - width) / 2),
                monitor.y,
            ];
        }
        const [vertical, horizontal] = pos.split('-');
        const margin = this._settings.get_int('margin');
        let x = monitor.x + Math.floor((monitor.width - width) / 2);
        if (horizontal === 'left')
            x = monitor.x + margin;
        else if (horizontal === 'right')
            x = monitor.x + monitor.width - width - margin;
        const topOffset = this._isTopBarHidden() ? 0 : Main.panel.height;
        const y = vertical === 'bottom'
            ? monitor.y + monitor.height - height - margin
            : monitor.y + topOffset + margin;
        return [x, y];
    }

    _getExpandedWidth() {
        const baseW = this._settings.get_int('expanded-width');
        return (this._activeTab === 'notes' || this._activeTab === 'hub' ||
            this._activeTab === 'file' || (this._activeTab === 'system' && this._systemSubView))
            ? Math.max(490, baseW)
            : baseW;
    }

    _morph(change) {
        const [fromWidth, fromHeight] = this.get_size();
        const fromLayout = this._layout;

        this.remove_transition('width');
        this.remove_transition('height');
        this.remove_transition('x');
        this.remove_transition('y');

        this.set_size(-1, -1);
        change();
        this._layout = this._expanded && !this._toastActive ? this._expandedGeometry() : this._compact();
        const to = this._layout;
        this._applyBoxStyle(to);

        let toWidth;
        if (to.expanded) {
            toWidth = this._getExpandedWidth();
            this.width = toWidth;
        } else {
            const [, natWidth] = this.get_preferred_width(-1);
            toWidth = Math.round(natWidth);
        }
        const [, natHeight] = this.get_preferred_height(toWidth);
        const toHeight = Math.round(natHeight);

        if (!to.expanded)
            this._restWidth = toWidth;

        const [toX, toY] = this._computeTargetPosition(toWidth, toHeight);
        this._targetX = toX;
        this._targetY = toY;
        this._targetW = toWidth;
        this._targetH = toHeight;

        if (!this._shown || !fromWidth) {
            this.set_position(toX, toY);
            return;
        }

        if (Math.abs(toWidth - fromWidth) <= 1 && Math.abs(toHeight - fromHeight) <= 1 && to === fromLayout) {
            this.set_position(toX, toY);
            return;
        }

        const {duration, mode} = this._getAnimProfile();
        if (duration === 0) {
            this.set_size(to.expanded ? toWidth : -1, -1);
            this.set_position(toX, toY);
            return;
        }

        const [fromX, fromY] = this._computeTargetPosition(fromWidth, fromHeight);
        this._morphing = true;
        this.set_size(fromWidth, fromHeight);
        this.set_position(fromX, fromY);

        this.ease({
            width: toWidth,
            height: toHeight,
            x: toX,
            y: toY,
            duration,
            mode,
            onComplete: () => {
                this._morphing = false;
                this.set_size(to.expanded ? toWidth : -1, -1);
                this.set_position(toX, toY);
            },
        });
    }

    _applyBoxStyle(geometry) {
        this._geometry = geometry;
        const px = v => `${Math.max(0, Math.round(v))}px`;
        const top = px(geometry.topRadius ?? geometry.radius);
        const bottom = px(geometry.radius);

        let minWidth = 0;
        if (geometry.expanded) {
            minWidth = this._getExpandedWidth();
        } else if (!this._toastActive && !geometry.dodged) {
            minWidth = Math.max(0, this._settings.get_int('width'));
        }

        const nextStyle = `border-radius: ${top} ${top} ${bottom} ${bottom}; padding: ${geometry.padding.map(px).join(' ')};` +
            (minWidth > 0 ? ` min-width: ${minWidth}px;` : '');

        if (nextStyle !== this._lastMainStyle) {
            this._lastMainStyle = nextStyle;
            this.style = nextStyle;
        }
    }

    _swapTrack(player) {
        const apply = () => this._morph(() => {
            this._compactTitle.text = player.trackTitle;
            this._title.text = player.trackTitle;
            this._artist.text = player.trackArtists.join(', ') || 'Artista sconosciuto';
            this._setArt(player.trackCoverUrl);
        });

        const {duration} = this._getAnimProfile();
        if (duration === 0 || !this._shown) {
            apply();
            return;
        }

        // Smooth track slide + album art elastic pop
        this._compactTitle.remove_all_transitions();
        this._compactTitle.ease({
            opacity: 0,
            translation_y: -6,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                apply();
                this._compactTitle.set({opacity: 0, translation_y: 6});
                this._compactTitle.ease({
                    opacity: 255,
                    translation_y: 0,
                    duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            },
        });

        this._art.remove_all_transitions();
        this._art.set({scale_x: 0.72, scale_y: 0.72});
        this._art.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 340,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _setArt(url) {
        if (!url || !url.startsWith('http')) {
            this._setArtBackground(url?.startsWith('file://') ? url : null);
            return;
        }
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'dynamic-island-notch']);
        GLib.mkdir_with_parents(dir, 0o755);
        const dest = Gio.File.new_for_path(`${dir}/${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1)}`);
        if (dest.query_exists(null)) {
            this._setArtBackground(dest.get_uri());
            return;
        }
        Gio.File.new_for_uri(url).copy_async(dest, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT,
            this._artCancellable, null, (file, res) => {
                try {
                    file.copy_finish(res);
                } catch (e) {
                    return;
                }
                this._setArtBackground(dest.get_uri());
            });
    }

    _setArtBackground(uri) {
        this._artBackground = uri ? `background-image: url("${uri}");` : '';
        this._updateStaticStyles();
    }

    // --- ZERO-IDLE-OVERHEAD EQUALIZER ---
    _eqWidth() {
        return EQ_WIDTH[this._settings.get_string('eq-style')] ?? EQ_WIDTH.bars;
    }

    _setEqStyle() {
        this._eq.width = this._eqWidth();
        this._refresh();
    }

    _syncEqState() {
        const shouldAnimate = this._shown && this._hasMusic &&
            this._playerStatus() === 'Playing' && this._eq.visible && !this._expanded;

        if (shouldAnimate && !this._eqRunning) {
            this._eqRunning = true;
            this._tickEq();
            this._eqId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => this._tickEq());
            this._eqTimeline.start();
        } else if (!shouldAnimate && this._eqRunning) {
            this._stopEqLoop();
            this._levels.fill(0.1);
            if (this._eq.visible)
                this._eq.queue_repaint();
        }
    }

    _stopEqLoop() {
        this._eqRunning = false;
        if (this._eqId) {
            GLib.source_remove(this._eqId);
            this._eqId = 0;
        }
        this._eqTimeline?.stop();
    }

    _tickEq() {
        if (!this._eqRunning)
            return GLib.SOURCE_REMOVE;
        const playing = this._playerStatus() === 'Playing';
        for (let i = 0; i < EQ_LEVELS; i++)
            this._targets[i] = playing ? 0.15 + Math.random() * 0.85 : 0.08;
        return GLib.SOURCE_CONTINUE;
    }

    _stepEq(dt) {
        if (!this._eqRunning || !this._eq.visible)
            return;
        const ease = 1 - Math.exp(-dt * 10);
        for (let i = 0; i < EQ_LEVELS; i++)
            this._levels[i] += (this._targets[i] - this._levels[i]) * ease;
        this._phase += dt * 5;
        this._eq.queue_repaint();
    }

    _levelAt(x) {
        const t = x * (EQ_LEVELS - 1), i = Math.min(Math.floor(t), EQ_LEVELS - 2);
        const f = (1 - Math.cos((t - i) * Math.PI)) / 2;
        return lerp(this._levels[i], this._levels[i + 1], f);
    }

    _drawEq(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [top, bottom] = this._accent;
        const gradKey = `${h}:${top[0]},${top[1]},${top[2]}:${bottom[0]},${bottom[1]},${bottom[2]}`;
        if (!this._eqGrad || this._eqGradKey !== gradKey) {
            this._eqGradKey = gradKey;
            this._eqGrad = new Cairo.LinearGradient(0, 0, 0, h);
            this._eqGrad.addColorStopRGB(0, ...top);
            this._eqGrad.addColorStopRGB(1, ...bottom);
        }
        cr.setSource(this._eqGrad);
        const levels = this._levels;
        const taper = x => Math.sin(Math.PI * x);

        switch (this._settings.get_string('eq-style')) {
        case 'spectrum':
            levels.forEach((level, i) => {
                const bh = 2 + level * (h - 2) * (1 - i * 0.06);
                roundedRect(cr, i * 4, h - bh, 2, bh);
            });
            cr.fill();
            break;
        case 'segments':
            for (let i = 0; i < 4; i++) {
                const lit = Math.max(1, Math.ceil(levels[i * 2] * 5));
                for (let j = 0; j < lit; j++)
                    roundedRect(cr, i * 6.33, h - j * 3.6 - 2.8, 4, 2.8);
            }
            cr.fill();
            break;
        case 'solid':
            cr.moveTo(0, h);
            for (let x = 0; x <= w; x++)
                cr.lineTo(x, h - 1 - this._levelAt(x / w) * (h - 1) * Math.sqrt(taper(x / w)));
            cr.lineTo(w, h);
            cr.fill();
            break;
        case 'wave': {
            const amp = levels.reduce((a, b) => a + b) / EQ_LEVELS * (h / 2 - 1.5);
            cr.setLineWidth(2);
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let x = 1; x < w; x++)
                cr.lineTo(x, h / 2 + amp * Math.sin(x / w * 3 * Math.PI + this._phase) * taper(x / w));
            cr.stroke();
            break;
        }
        case 'ribbon': {
            const half = x => (0.75 + this._levelAt(x) * (h / 2 - 1)) * taper(x) *
                (0.75 + 0.25 * Math.sin(x * 2 * Math.PI + this._phase));
            for (let x = 0; x <= w; x++)
                cr.lineTo(x, h / 2 - half(x / w));
            for (let x = w; x >= 0; x--)
                cr.lineTo(x, h / 2 + half(x / w));
            cr.fill();
            break;
        }
        default:
            for (let i = 0; i < 4; i++) {
                const bh = 3 + levels[i * 2] * (h - 3);
                roundedRect(cr, i * 6, (h - bh) / 2, 3, bh);
            }
            cr.fill();
        }
        cr.$dispose();
    }

    _reposition() {
        if (this._morphing)
            return;
        const [w, h] = this.get_size();
        const [x, y] = this._computeTargetPosition(w, h);
        this._targetX = x;
        this._targetY = y;
        this._targetW = w;
        this._targetH = h;
        this.set_position(x, y);
    }
});
