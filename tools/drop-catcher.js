#!/usr/bin/env gjs
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

Gio._promisify(Gio.OutputStream.prototype, 'splice_async', 'splice_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const WIN_TITLE = System.programArgs[0] || 'DI-DropCatcher';
const SHELF_CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'dynamic-island-shelf']);
const IMAGE_MIMES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/bmp',
    'image/svg+xml',
];
const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-ms-bmp': 'bmp',
    'image/svg+xml': 'svg',
};

const httpSession = new Soup.Session({timeout: 8});
let cacheSeq = 1;

function pruneOldCacheFiles() {
    try {
        GLib.mkdir_with_parents(SHELF_CACHE_DIR, 0o755);
        const dir = Gio.File.new_for_path(SHELF_CACHE_DIR);
        const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const cutoffUs = GLib.get_real_time() - 7 * 86400 * 1000000;
        let info;
        while ((info = en.next_file(null)) !== null) {
            const mtimeUs = Number(info.get_attribute_uint64('time::modified')) * 1000000;
            if (mtimeUs > 0 && mtimeUs < cutoffUs)
                dir.get_child(info.get_name()).delete(null);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}
pruneOldCacheFiles();

if (!GLib.getenv('GSK_RENDERER'))
    GLib.setenv('GSK_RENDERER', 'cairo', true);
if (!GLib.getenv('GTK_A11Y'))
    GLib.setenv('GTK_A11Y', 'none', true);

Gtk.init();

const loop = new GLib.MainLoop(null, false);
const stdout = new Gio.DataOutputStream({
    base_stream: new GioUnix.OutputStream({fd: 1, close_fd: false}),
});

let win = null;
let trayDragActive = false;

function emit(obj) {
    try {
        stdout.put_string(`${JSON.stringify(obj)}\n`, null);
        stdout.flush(null);
    } catch (e) {
        loop.quit();
    }
}

const css = new Gtk.CssProvider();
css.load_from_string(`
    window.di-helper {
        background: rgba(0, 0, 0, 0.004);
        box-shadow: none;
        border: none;
        outline: none;
    }
    .di-drop-surface {
        background: rgba(10, 132, 255, 0.004);
    }
    .di-tray-pill {
        background-color: rgba(11, 11, 15, 0.94);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 16px;
        padding: 5px 6px;
    }
    .di-tray-tile {
        background-color: rgba(255, 255, 255, 0.09);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
    }
    .di-tray-tile-hover {
        background-color: rgba(10, 132, 255, 0.25);
        border: 1.5px solid rgba(10, 132, 255, 0.9);
    }
    .di-tray-icon {
        color: #e5e5ea;
    }
    .di-tray-ext {
        background-color: rgba(0, 0, 0, 0.72);
        border-radius: 4px;
        padding: 1px 4px;
        color: #e5e5ea;
        font-size: 7.5pt;
        font-weight: 800;
    }
    button.di-tray-close-btn {
        min-width: 20px;
        min-height: 20px;
        padding: 0;
        margin: 0;
        border-radius: 999px;
        background-color: rgba(18, 18, 24, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.36);
        color: #ffffff;
    }
    button.di-tray-close-btn:hover {
        background-color: #ff453a;
        border-color: #ff453a;
    }
    .di-drag-pill {
        background-color: rgba(16, 16, 22, 0.96);
        border: 1px solid rgba(10, 132, 255, 0.7);
        border-radius: 16px;
        padding: 10px 16px;
        color: #ffffff;
        font-weight: bold;
    }
`);
Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(),
    css,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1
);

function buildOutContentProvider(files, isImage, dragSource) {
    const fileList = Gdk.FileList.new_from_array(files);
    if (isImage && files.length === 1) {
        try {
            const path = files[0].get_path();
            if (path) {
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 48, 48, true);
                dragSource.set_icon(Gdk.Texture.new_for_pixbuf(pb), 24, 24);
            }
        } catch (e) {
            // Ignore preview errors
        }
    }
    return Gdk.ContentProvider.new_for_value(fileList);
}

function createWindow(w, h) {
    if (win) {
        win.destroy();
        win = null;
    }
    const wnd = new Gtk.Window({
        title: WIN_TITLE,
        decorated: false,
        resizable: false,
        focusable: false,
        focus_on_click: false,
        default_width: w,
        default_height: h,
    });
    wnd.add_css_class('di-helper');
    wnd.connect('close-request', () => {
        wnd.set_visible(false);
        return true;
    });
    const keyCtrl = new Gtk.EventControllerKey();
    keyCtrl.connect('key-pressed', (_c, keyval) => {
        if (keyval === Gdk.KEY_Escape) {
            wnd.hide();
            return true;
        }
        return false;
    });
    wnd.add_controller(keyCtrl);
    win = wnd;
    return wnd;
}

function decodeMimeText(bytes) {
    if (!bytes || bytes.length === 0)
        return '';
    const isUtf16Le = (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) ||
        (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0);
    const str = new TextDecoder(isUtf16Le ? 'utf-16le' : 'utf-8').decode(bytes);
    return str.replace(/^\uFEFF/, '').replace(/\0+$/, '');
}

function sniffImageExt(bytes, mimeHint = '') {
    if (!bytes || bytes.length < 4)
        return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return 'jpg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
        return 'gif';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
        return 'webp';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d)
        return 'bmp';
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (brand === 'avif' || brand === 'avis')
            return 'avif';
    }
    const cleanMime = (mimeHint || '').split(';')[0].trim().toLowerCase();
    if (MIME_TO_EXT[cleanMime])
        return MIME_TO_EXT[cleanMime];
    try {
        const head = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(256, bytes.length))).trimStart();
        if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')))
            return 'svg';
    } catch (e) {
        // Not text/SVG
    }
    return null;
}

function saveImageBytes(bytes, mimeHint = '', nameHint = 'immagine') {
    const ext = sniffImageExt(bytes, mimeHint);
    if (!ext)
        return null;
    try {
        GLib.mkdir_with_parents(SHELF_CACHE_DIR, 0o755);
        let base = (nameHint || 'immagine')
            .replace(/\.[a-z0-9]{1,5}$/i, '')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 36);
        if (!base)
            base = 'immagine';
        const filename = `${base}-${Date.now()}-${cacheSeq++}.${ext}`;
        const outPath = GLib.build_filenamev([SHELF_CACHE_DIR, filename]);
        const file = Gio.File.new_for_path(outPath);
        file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return file.get_uri();
    } catch (e) {
        printerr(`[DI-DND] saveImageBytes error: ${e.message}\n`);
        return null;
    }
}

function decodeDataImageUri(dataUri) {
    if (!dataUri || !dataUri.startsWith('data:image/'))
        return null;
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx < 0)
        return null;
    const meta = dataUri.slice(5, commaIdx);
    const payload = dataUri.slice(commaIdx + 1);
    const mime = meta.split(';')[0].trim().toLowerCase();
    try {
        if (/;base64/i.test(meta)) {
            const raw = GLib.base64_decode(payload.replace(/\s+/g, ''));
            return saveImageBytes(raw, mime, 'web-image');
        }
        const decodedText = decodeURIComponent(payload);
        const bytes = new TextEncoder().encode(decodedText);
        return saveImageBytes(bytes, mime, 'web-image');
    } catch (e) {
        return null;
    }
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/gi, '&')
        .replace(/&#38;/g, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function extractGoogleImgRes(rawUrl) {
    if (!rawUrl || !rawUrl.includes('imgurl='))
        return {imgUrl: null, refUrl: null};
    try {
        const qIdx = rawUrl.indexOf('?');
        if (qIdx < 0)
            return {imgUrl: null, refUrl: null};
        const params = rawUrl.slice(qIdx + 1).split('&');
        let imgUrl = null;
        let refUrl = null;
        for (const p of params) {
            const eq = p.indexOf('=');
            if (eq < 0)
                continue;
            const k = p.slice(0, eq);
            const v = decodeURIComponent(p.slice(eq + 1).replace(/\+/g, ' '));
            if (k === 'imgurl' && /^https?:\/\//i.test(v))
                imgUrl = v;
            else if (k === 'imgrefurl' && /^https?:\/\//i.test(v))
                refUrl = v;
        }
        return {imgUrl, refUrl};
    } catch (e) {
        return {imgUrl: null, refUrl: null};
    }
}

function normalizeWebUrl(u) {
    if (!u)
        return null;
    const cleaned = decodeHtmlEntities(u.trim());
    if (cleaned.startsWith('//'))
        return `https:${cleaned}`;
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.startsWith('data:image/'))
        return cleaned;
    return null;
}

function extractFromHtml(html) {
    const imgSrcs = [];
    let googleImgUrl = null;
    let referer = null;

    const hrefRegex = /href\s*=\s*(['"])(.*?)\1/gi;
    let hm;
    while ((hm = hrefRegex.exec(html)) !== null) {
        const href = normalizeWebUrl(hm[2]);
        if (!href)
            continue;
        if (!referer && href.startsWith('http'))
            referer = href;
        const g = extractGoogleImgRes(href);
        if (g.imgUrl && !googleImgUrl) {
            googleImgUrl = g.imgUrl;
            if (g.refUrl)
                referer = g.refUrl;
        }
    }

    const imgTagRegex = /<img\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = imgTagRegex.exec(html)) !== null) {
        const tag = tagMatch[0];
        const attrRegex = /\b(?:src|data-src)\s*=\s*(['"])(.*?)\1/gi;
        let am;
        while ((am = attrRegex.exec(tag)) !== null) {
            const candidate = normalizeWebUrl(am[2]);
            if (candidate && !imgSrcs.includes(candidate))
                imgSrcs.push(candidate);
        }
        const srcsetMatch = /\bsrcset\s*=\s*(['"])(.*?)\1/i.exec(tag);
        if (srcsetMatch) {
            const firstEntry = srcsetMatch[2].split(',')[0]?.trim().split(/\s+/)[0];
            const candidate = normalizeWebUrl(firstEntry);
            if (candidate && !imgSrcs.includes(candidate))
                imgSrcs.push(candidate);
        }
    }

    return {googleImgUrl, imgSrcs, referer};
}

function readDropStream(drop, mimeTypes) {
    return new Promise((resolve, reject) => {
        drop.read_async(mimeTypes, GLib.PRIORITY_DEFAULT, null, (d, res) => {
            try {
                resolve(d.read_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readDropBytes(drop, mimeTypes) {
    const [stream, outMime] = await readDropStream(drop, mimeTypes);
    const out = Gio.MemoryOutputStream.new_resizable();
    await out.splice_async(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT, null);
    const gbytes = out.steal_as_bytes();
    return [gbytes.get_data(), outMime];
}

async function downloadImageUrl(url, referer = null) {
    if (!url)
        return null;
    if (url.startsWith('data:image/'))
        return decodeDataImageUri(url);
    if (!/^https?:\/\//i.test(url))
        return null;
    try {
        const msg = Soup.Message.new('GET', url);
        if (!msg)
            return null;
        msg.request_headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0');
        msg.request_headers.append('Accept', 'image/avif,image/webp,image/png,image/*;q=0.9,*/*;q=0.5');
        if (referer && /^https?:\/\//i.test(referer))
            msg.request_headers.append('Referer', referer);

        const gbytes = await httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
        const status = msg.get_status();
        if (status < 200 || status >= 300)
            return null;
        const data = gbytes.get_data();
        if (!data || data.length === 0)
            return null;
        const [contentType] = msg.get_response_headers().get_content_type();
        const urlName = url.split('?')[0].split('#')[0].split('/').pop() || 'web-image';
        return saveImageBytes(data, contentType || '', urlName);
    } catch (e) {
        return null;
    }
}

async function handleAsyncDrop(drop) {
    const uris = [];
    const fallbackUrls = [];
    let mimes = [];
    try {
        mimes = drop.get_formats().get_mime_types() || [];
    } catch (e) {
        mimes = [];
    }

    // 1. Local file:// URIs first (file manager / desktop)
    if (mimes.includes('text/uri-list')) {
        try {
            const [bytes] = await readDropBytes(drop, ['text/uri-list']);
            const text = decodeMimeText(bytes);
            for (const line of text.split(/\r?\n/)) {
                const s = line.trim();
                if (!s || s.startsWith('#'))
                    continue;
                if (s.startsWith('file://'))
                    uris.push(s);
                else if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/'))
                    fallbackUrls.push(s);
            }
            if (uris.length > 0)
                return uris;
        } catch (e) {
            // Continue to HTML / image formats
        }
    }

    // 2. HTML <img src> & Google Images imgres?imgurl=... extraction (prevents saving webpage link instead of image)
    let htmlCandidates = null;
    if (mimes.includes('text/html')) {
        try {
            const [bytes] = await readDropBytes(drop, ['text/html']);
            const html = decodeMimeText(bytes);
            htmlCandidates = extractFromHtml(html);

            if (htmlCandidates.googleImgUrl) {
                const saved = await downloadImageUrl(htmlCandidates.googleImgUrl, htmlCandidates.referer);
                if (saved)
                    return [saved];
            }
            for (const src of htmlCandidates.imgSrcs) {
                const saved = await downloadImageUrl(src, htmlCandidates.referer);
                if (saved)
                    return [saved];
            }
        } catch (e) {
            // Continue to direct image MIME payload
        }
    }

    // 3. Raw binary image MIME directly from Firefox / Chrome drag offer
    const offeredImgMimes = IMAGE_MIMES.filter(m => mimes.includes(m));
    for (const imgMime of offeredImgMimes) {
        try {
            const [bytes, actualMime] = await readDropBytes(drop, [imgMime]);
            const saved = saveImageBytes(bytes, actualMime || imgMime, 'browser-image');
            if (saved)
                return [saved];
        } catch (e) {
            // Try next image MIME
        }
    }

    // 4. Text / Moz-URL fallback (direct image URLs or Google imgres links)
    const textMimes = ['text/x-moz-url', 'text/plain;charset=utf-8', 'text/plain'].filter(m => mimes.includes(m));
    for (const tm of textMimes) {
        try {
            const [bytes] = await readDropBytes(drop, [tm]);
            const text = decodeMimeText(bytes);
            for (const line of text.split(/\r?\n/)) {
                const s = normalizeWebUrl(line);
                if (s && !fallbackUrls.includes(s))
                    fallbackUrls.push(s);
            }
        } catch (e) {
            // Ignore
        }
    }

    for (const url of fallbackUrls) {
        const g = extractGoogleImgRes(url);
        if (g.imgUrl) {
            const saved = await downloadImageUrl(g.imgUrl, g.refUrl);
            if (saved)
                return [saved];
        }
        const saved = await downloadImageUrl(url, htmlCandidates?.referer || null);
        if (saved)
            return [saved];
    }

    return [];
}

function buildDropWindow(w, h) {
    const wnd = createWindow(w, h);
    const area = new Gtk.Box({hexpand: true, vexpand: true});
    area.add_css_class('di-drop-surface');

    const target = new Gtk.DropTargetAsync({
        actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK,
    });

    target.connect('accept', () => true);
    target.connect('drag-enter', () => {
        emit({type: 'over', inside: true});
        return Gdk.DragAction.COPY;
    });
    target.connect('drag-motion', () => Gdk.DragAction.COPY);
    target.connect('drag-leave', () => {
        emit({type: 'over', inside: false});
    });
    target.connect('drop', (_t, drop) => {
        emit({type: 'drop-pending'});
        (async () => {
            let savedUris = [];
            try {
                savedUris = await handleAsyncDrop(drop);
            } catch (e) {
                printerr(`[DI-DND] drop error: ${e.message}\n`);
            }
            if (savedUris.length > 0) {
                try {
                    drop.finish(Gdk.DragAction.COPY);
                } catch (e) {
                    // Ignore
                }
                emit({type: 'files', uris: savedUris});
            } else {
                try {
                    drop.finish(0);
                } catch (e) {
                    // Ignore
                }
                emit({type: 'drop-failed'});
            }
        })();
        return true;
    });
    area.add_controller(target);
    wnd.set_child(area);
    wnd.present();
}

function buildTrayWindow(w, h, tiles) {
    const wnd = createWindow(w, h);
    const pill = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
        hexpand: true,
        vexpand: true,
    });
    pill.add_css_class('di-tray-pill');

    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true,
    });

    for (const item of tiles) {
        const overlay = new Gtk.Overlay();
        overlay.set_size_request(44, 44);

        const tileBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.FILL,
            overflow: Gtk.Overflow.HIDDEN,
        });
        tileBox.set_size_request(44, 44);
        tileBox.add_css_class('di-tray-tile');
        tileBox.set_tooltip_text(`${item.name}\nTrascina fuori · Doppio click / tasto destro per aprire`);

        const file = Gio.File.new_for_uri(item.uri);
        if (item.isImage) {
            let thumbImg = null;
            try {
                const path = file.get_path();
                if (path) {
                    const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 42, 42, true);
                    const tex = Gdk.Texture.new_for_pixbuf(pb);
                    thumbImg = new Gtk.Image({
                        paintable: tex,
                        pixel_size: 42,
                        halign: Gtk.Align.CENTER,
                        valign: Gtk.Align.CENTER,
                    });
                }
            } catch (e) {
                thumbImg = null;
            }
            if (thumbImg) {
                tileBox.append(thumbImg);
            } else {
                tileBox.append(new Gtk.Image({
                    icon_name: 'image-x-generic-symbolic',
                    pixel_size: 22,
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                }));
            }
        } else {
            const inner = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 2,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
                hexpand: true,
                vexpand: true,
            });
            const icon = new Gtk.Image({
                icon_name: item.iconName || 'text-x-generic-symbolic',
                pixel_size: 20,
            });
            icon.add_css_class('di-tray-icon');
            const dotIdx = item.name.lastIndexOf('.');
            const ext = dotIdx > 0 ? item.name.slice(dotIdx + 1, dotIdx + 5).toUpperCase() : 'FILE';
            const extLbl = new Gtk.Label({label: ext});
            extLbl.add_css_class('di-tray-ext');
            inner.append(icon);
            inner.append(extLbl);
            tileBox.append(inner);
        }

        const dragSource = new Gtk.DragSource({
            actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK,
        });
        dragSource.connect('prepare', () => buildOutContentProvider([file], item.isImage, dragSource));
        dragSource.connect('drag-begin', () => {
            trayDragActive = true;
            printerr(`[DI-DND] tray drag-begin: ${item.uri}\n`);
            emit({type: 'tray-drag-begin', uri: item.uri});
        });
        dragSource.connect('drag-end', (_src, _drag, deleteData) => {
            trayDragActive = false;
            printerr(`[DI-DND] tray drag-end deleteData=${deleteData}: ${item.uri}\n`);
            emit({type: 'tray-drag-end', uri: item.uri});
        });
        dragSource.connect('drag-cancel', (_src, _drag, reason) => {
            trayDragActive = false;
            printerr(`[DI-DND] tray drag-cancel reason=${reason}: ${item.uri}\n`);
            emit({type: 'tray-drag-end', uri: item.uri});
            return false;
        });
        tileBox.add_controller(dragSource);

        const clickCtrl = new Gtk.GestureClick({button: 0});
        clickCtrl.connect('pressed', (gesture, nPress) => {
            const btn = gesture.get_current_button();
            if (btn === 2 || btn === 3 || (btn === 1 && nPress >= 2))
                emit({type: 'open-uri', uri: item.uri});
        });
        tileBox.add_controller(clickCtrl);

        overlay.set_child(tileBox);

        const closeIcon = new Gtk.Image({
            icon_name: 'window-close-symbolic',
            pixel_size: 12,
            can_target: false,
        });
        const closeBtn = new Gtk.Button({
            child: closeIcon,
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            visible: true,
            can_focus: false,
            focus_on_click: false,
            has_frame: false,
        });
        closeBtn.add_css_class('di-tray-close-btn');

        let removed = false;
        const triggerRemove = () => {
            if (removed)
                return;
            removed = true;
            if (tiles.length <= 1)
                wnd.set_visible(false);
            else
                overlay.set_visible(false);
            emit({type: 'remove-uri', uri: item.uri});
        };

        const closeClick = new Gtk.GestureClick({
            button: 1,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        closeClick.connect('pressed', gesture => {
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        });
        closeClick.connect('released', (_gesture, _nPress, x, y) => {
            const bw = closeBtn.get_width() || 20;
            const bh = closeBtn.get_height() || 20;
            if (x >= -6 && x <= bw + 6 && y >= -6 && y <= bh + 6)
                triggerRemove();
        });
        closeBtn.add_controller(closeClick);
        closeBtn.connect('clicked', triggerRemove);

        overlay.add_overlay(closeBtn);
        overlay.set_clip_overlay(closeBtn, false);

        const hoverCtrl = new Gtk.EventControllerMotion();
        hoverCtrl.connect('enter', () => {
            tileBox.add_css_class('di-tray-tile-hover');
        });
        hoverCtrl.connect('leave', () => {
            tileBox.remove_css_class('di-tray-tile-hover');
        });
        overlay.add_controller(hoverCtrl);

        row.append(overlay);
    }

    pill.append(row);
    wnd.set_child(pill);
    wnd.present();
}

function buildDragWindow(uris, label) {
    const wnd = createWindow(320, 56);
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
    });
    box.add_css_class('di-drag-pill');
    const lbl = new Gtk.Label({
        label: `Trascina ora: ${label || 'file'}`,
        hexpand: true,
    });
    const closeBtn = new Gtk.Button({
        icon_name: 'window-close-symbolic',
        has_frame: false,
    });
    closeBtn.connect('clicked', () => wnd.destroy());
    box.append(lbl);
    box.append(closeBtn);

    const dragSource = new Gtk.DragSource({
        actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE | Gdk.DragAction.LINK,
    });
    dragSource.connect('prepare', () => {
        if (!uris || uris.length === 0)
            return null;
        const files = uris.map(u => Gio.File.new_for_uri(u));
        const isImg = uris.length === 1 && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(uris[0]);
        return buildOutContentProvider(files, isImg, dragSource);
    });
    dragSource.connect('drag-begin', () => {
        trayDragActive = true;
    });
    dragSource.connect('drag-end', () => {
        trayDragActive = false;
        wnd.destroy();
        win = null;
        emit({type: 'drag-out-end'});
    });
    dragSource.connect('drag-cancel', () => {
        trayDragActive = false;
        return false;
    });
    box.add_controller(dragSource);

    wnd.set_child(box);
    wnd.present();
}

const stdin = new Gio.DataInputStream({
    base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
});

function readStdin() {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let line = null;
        try {
            [line] = s.read_line_finish_utf8(res);
        } catch (e) {
            loop.quit();
            return;
        }
        if (line === null) {
            loop.quit();
            return;
        }
        try {
            const cmd = JSON.parse(line);
            if (cmd.cmd === 'show-drop') {
                if (!trayDragActive)
                    buildDropWindow(Math.max(120, Math.round(cmd.w || 490)), Math.max(80, Math.round(cmd.h || 230)));
            } else if (cmd.cmd === 'show-tray-drag') {
                if (!trayDragActive) {
                    buildTrayWindow(
                        Math.max(58, Math.round(cmd.w || 60)),
                        Math.max(56, Math.round(cmd.h || 56)),
                        cmd.tiles || []
                    );
                }
            } else if (cmd.cmd === 'show-drag') {
                if (!trayDragActive)
                    buildDragWindow(cmd.uris || [], cmd.label);
            } else if (cmd.cmd === 'hide') {
                if (!trayDragActive && win) {
                    win.destroy();
                    win = null;
                }
            } else if (cmd.cmd === 'quit') {
                loop.quit();
                return;
            }
        } catch (e) {
            // Ignore malformed command
        }
        readStdin();
    });
}

readStdin();
emit({type: 'ready'});
loop.run();
