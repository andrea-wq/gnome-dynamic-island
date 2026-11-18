import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const CATCHER = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('tools').get_child('drop-catcher.js').get_path();

const DROP_GRACE_MS = 1400;

export class FileShelfBridge {
    constructor(hooks) {
        this._hooks = hooks;
        this._dragging = false;
        this._draggingOut = false;
        this._armed = false;
        this._pendingDrop = false;
        this._trayShown = false;
        this._lastTrayKey = null;
        this._dropped = false;
        this._proc = null;
        this._helperPid = 0;
        this._winTitle = `DI-DropCatcher-${GLib.get_monotonic_time()}`;
        this._stdin = null;
        this._stdout = null;
        this._ready = false;
        this._win = null;
        this._winReady = false;
        this._pendingCmd = null;
        this._targetRect = {x: 0, y: 0, width: 490, height: 230};
        this._graceId = 0;
        this._cancellable = new Gio.Cancellable();

        const dnd = global.backend.get_dnd();
        this._dnd = dnd;
        this._dndIds = [
            dnd.connect('dnd-enter', () => this._onEnter()),
            dnd.connect('dnd-position-change', (_o, x, y) => this._onMove(x, y)),
            dnd.connect('dnd-leave', () => this._onLeave()),
        ];
        this._windowCreatedId = global.display.connect('window-created', (_d, win) => {
            this._onWindowCreated(win);
        });

        this._ensureHelper();
    }

    _ensureHelper() {
        if (this._proc)
            return;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            launcher.setenv('GSK_RENDERER', 'cairo', true);
            launcher.setenv('GTK_A11Y', 'none', true);
            try {
                this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, ['gjs', '-m', CATCHER, this._winTitle]);
                this._proc = this._client.get_subprocess();
            } catch (wcErr) {
                this._client = null;
                this._proc = launcher.spawnv(['gjs', '-m', CATCHER, this._winTitle]);
            }
            this._helperPid = Number(this._proc.get_identifier()) || 0;
            this._stdin = this._proc.get_stdin_pipe();
            this._stdout = new Gio.DataInputStream({
                base_stream: this._proc.get_stdout_pipe(),
            });
            this._readHelperStdout();
        } catch (e) {
            console.warn(`[DI-DND] helper spawn failed: ${e.message}`);
            this._stopHelper();
        }
    }

    _readHelperStdout() {
        if (!this._stdout)
            return;
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                return;
            }
            if (line === null) {
                this._stopHelper();
                return;
            }
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'ready') {
                    this._ready = true;
                    if (this._pendingCmd) {
                        const pending = this._pendingCmd;
                        this._pendingCmd = null;
                        this._sendCmd(pending);
                    }
                } else if (msg.type === 'over') {
                    this._hooks.onOver?.(msg.inside);
                } else if (msg.type === 'drop-pending') {
                    this._pendingDrop = true;
                    if (this._graceId) {
                        GLib.source_remove(this._graceId);
                        this._graceId = 0;
                    }
                    this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 12000, () => {
                        this._graceId = 0;
                        this._pendingDrop = false;
                        this._disarm();
                        this._hooks.onDragEnd?.(this._dropped);
                        return GLib.SOURCE_REMOVE;
                    });
                    this._hooks.onDropPending?.();
                } else if (msg.type === 'drop-failed') {
                    this._pendingDrop = false;
                    if (this._graceId) {
                        GLib.source_remove(this._graceId);
                        this._graceId = 0;
                    }
                    this._disarm();
                    this._hooks.onDragEnd?.(false);
                } else if (msg.type === 'files' && Array.isArray(msg.uris)) {
                    const wasPending = this._pendingDrop;
                    this._pendingDrop = false;
                    this._dropped = true;
                    this._hooks.onFiles?.(msg.uris);
                    this._disarm();
                    if (wasPending) {
                        if (this._graceId) {
                            GLib.source_remove(this._graceId);
                            this._graceId = 0;
                        }
                        this._hooks.onDragEnd?.(true);
                    }
                } else if (msg.type === 'drag-out-end') {
                    this._hooks.onDragOutEnd?.();
                } else if (msg.type === 'tray-drag-begin') {
                    this._draggingOut = true;
                    this._dragging = false;
                    if (this._armed)
                        this._disarm();
                } else if (msg.type === 'tray-drag-end') {
                    this._draggingOut = false;
                    this._dragging = false;
                    this._hooks.onTrayDragEnd?.();
                } else if (msg.type === 'remove-uri' && msg.uri) {
                    console.log(`[DI-DND] remove-uri requested: ${msg.uri}`);
                    this._hooks.onRemoveUri?.(msg.uri);
                } else if (msg.type === 'open-uri' && msg.uri) {
                    this._hooks.onOpenUri?.(msg.uri);
                }
            } catch (e) {
                console.warn(`[DI-DND] helper msg error: ${e.message}`);
            }
            this._readHelperStdout();
        });
    }

    _sendCmd(obj) {
        if (!this._ready || !this._stdin) {
            this._pendingCmd = obj;
            this._ensureHelper();
            return;
        }
        try {
            const bytes = new TextEncoder().encode(`${JSON.stringify(obj)}\n`);
            this._stdin.write_all(bytes, null);
        } catch (e) {
            // Ignore write errors
        }
    }

    _onWindowCreated(win) {
        if (!this._proc)
            return;
        const owns = this._client ? this._client.owns_window(win) : false;
        const matchesTitle = win.get_title() === this._winTitle;
        const matchesPid = this._helperPid > 0 && win.get_pid() === this._helperPid;
        if (!owns && !matchesTitle && !matchesPid)
            return;

        this._win = win;
        this._winReady = false;
        try {
            this._client?.hide_from_window_list?.(win);
            win.stick();
        } catch (e) {
            // Ignore
        }
        win.connectObject('unmanaged', () => {
            if (this._win === win) {
                this._win = null;
                this._winReady = false;
            }
        }, this);
        const shownId = win.connect('shown', () => {
            win.disconnect(shownId);
            if (this._win !== win)
                return;
            this._winReady = true;
            this._positionHelperWindow();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._win === win && this._winReady)
                    this._positionHelperWindow();
                return GLib.SOURCE_REMOVE;
            });
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                if (this._win === win && this._winReady)
                    this._positionHelperWindow();
                return GLib.SOURCE_REMOVE;
            });
            if (this._armed && this._win === win)
                this._hooks.setPassThrough?.(true);
        });
    }

    _positionHelperWindow() {
        if (!this._win || !this._winReady)
            return;
        try {
            if (!this._win.is_above())
                this._win.make_above();
            this._win.move_resize_frame(
                true,
                Math.round(this._targetRect.x),
                Math.round(this._targetRect.y),
                Math.round(this._targetRect.width),
                Math.round(this._targetRect.height)
            );
        } catch (e) {
            console.warn(`[DI-DND] move_resize_frame err: ${e.message}`);
        }
    }

    _onEnter() {
        const [px, py] = global.get_pointer();
        const r = this._targetRect;
        const startedOnTray = this._trayShown && !!this._win && r &&
            px >= r.x - 14 && px <= r.x + r.width + 14 &&
            py >= r.y - 14 && py <= r.y + r.height + 14;
        if (startedOnTray) {
            this._draggingOut = true;
            this._dragging = false;
            return;
        }
        this._draggingOut = false;
        this._trayShown = false;
        this._lastTrayKey = null;
        this._dragging = true;
        this._dropped = false;
        this._pendingDrop = false;
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
        this._ensureHelper();
    }

    _onMove(x, y) {
        if (!this._dragging || this._draggingOut)
            return;
        if (!this._armed && this._hooks.hitTest?.(x, y)) {
            this._armed = true;
            this._hooks.onArm?.();
            const rect = this._hooks.targetRect?.();
            if (rect) {
                this._targetRect = rect;
                if (this._win)
                    this._hooks.setPassThrough?.(true);
                this._sendCmd({cmd: 'show-drop', w: rect.width, h: rect.height});
                this._positionHelperWindow();
            }
        }
    }

    _onLeave() {
        this._dragging = false;
        if (this._draggingOut || !this._armed || this._pendingDrop)
            return;
        if (this._graceId)
            GLib.source_remove(this._graceId);
        this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DROP_GRACE_MS, () => {
            this._graceId = 0;
            this._disarm();
            this._hooks.onDragEnd?.(this._dropped);
            return GLib.SOURCE_REMOVE;
        });
    }

    _disarm() {
        if (!this._armed)
            return;
        this._armed = false;
        this._lastTrayKey = null;
        this._hooks.setPassThrough?.(false);
        if (!this._draggingOut)
            this._sendCmd({cmd: 'hide'});
    }

    showTray(rect, tiles) {
        if (this._dragging || this._draggingOut || this._armed || !tiles || tiles.length === 0)
            return;
        const contentKey = JSON.stringify({
            w: rect.width,
            h: rect.height,
            uris: tiles.map(t => t.uri),
        });
        if (this._trayShown && this._lastTrayKey === contentKey && this._win) {
            if (rect.x !== this._targetRect.x || rect.y !== this._targetRect.y) {
                this._targetRect = rect;
                this._positionHelperWindow();
            }
            return;
        }
        this._trayShown = true;
        this._lastTrayKey = contentKey;
        this._targetRect = rect;
        this._sendCmd({
            cmd: 'show-tray-drag',
            w: rect.width,
            h: rect.height,
            tiles,
        });
        this._positionHelperWindow();
    }

    hideTray() {
        if (!this._trayShown)
            return;
        this._trayShown = false;
        this._lastTrayKey = null;
        if (!this._armed && !this._dragging && !this._draggingOut)
            this._sendCmd({cmd: 'hide'});
    }

    startDragOut(uris, label) {
        if (!uris || uris.length === 0)
            return;
        const [px, py] = global.get_pointer();
        this._targetRect = {x: Math.max(0, px - 140), y: Math.max(0, py - 26), width: 320, height: 58};
        this._ensureHelper();
        this._sendCmd({cmd: 'show-drag', uris, label});
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._positionHelperWindow();
            return GLib.SOURCE_REMOVE;
        });
    }

    copyUrisToClipboard(uris) {
        if (!uris || uris.length === 0)
            return;
        try {
            const payload = `${uris.join('\r\n')}\r\n`;
            const proc = Gio.Subprocess.new(
                ['wl-copy', '--type', 'text/uri-list'],
                Gio.SubprocessFlags.STDIN_PIPE
            );
            proc.communicate_utf8_async(payload, null, null);
        } catch (e) {
            // Ignore
        }
    }

    pasteUrisFromClipboard(callback) {
        try {
            const proc = Gio.Subprocess.new(
                ['wl-paste', '--no-newline', '--type', 'text/uri-list'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [ok, stdout] = p.communicate_utf8_finish(res);
                    if (ok && stdout) {
                        const uris = stdout.split(/\r?\n/)
                            .map(s => s.trim())
                            .filter(s => s && !s.startsWith('#') && s.startsWith('file://'));
                        if (uris.length > 0)
                            callback(uris);
                    }
                } catch (e) {
                    // Ignore empty clipboard
                }
            });
        } catch (e) {
            // Ignore
        }
    }

    _stopHelper() {
        if (this._proc) {
            try {
                this._sendCmd({cmd: 'quit'});
                this._proc.force_exit();
            } catch (e) {
                // Ignore
            }
        }
        this._win?.disconnectObject(this);
        this._win = null;
        this._winReady = false;
        this._proc = null;
        this._helperPid = 0;
        this._stdin = null;
        this._stdout = null;
        this._ready = false;
    }

    destroy() {
        for (const id of this._dndIds)
            this._dnd.disconnect(id);
        this._dndIds = [];
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
        if (this._armed)
            this._hooks.setPassThrough?.(false);
        this._armed = false;
        this._trayShown = false;
        this._lastTrayKey = null;
        this._cancellable.cancel();
        this._stopHelper();
    }
}
