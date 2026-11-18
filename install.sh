#!/usr/bin/env bash
set -euo pipefail

UUID="dynamic-island@notch-dev"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "1. Compilazione schema GSettings..."
glib-compile-schemas "$SRC_DIR/schemas/"

echo "2. Copia diretta e pacchettizzazione in $EXT_DIR..."
mkdir -p "$EXT_DIR/schemas" "$EXT_DIR/sources" "$EXT_DIR/tools"
cp -f "$SRC_DIR/extension.js" "$SRC_DIR/island.js" "$SRC_DIR/prefs.js" "$SRC_DIR/metadata.json" "$SRC_DIR/stylesheet.css" "$EXT_DIR/"
cp -rf "$SRC_DIR/schemas/"* "$EXT_DIR/schemas/"
cp -rf "$SRC_DIR/sources/"* "$EXT_DIR/sources/"
cp -rf "$SRC_DIR/tools/"* "$EXT_DIR/tools/"
chmod +x "$EXT_DIR/tools/"*.js || true
rm -rf "$HOME/.local/share/gnome-shell/extension-updates/$UUID"

echo "3. Riavvio a caldo dell'estensione (Disable -> Enable)..."
gnome-extensions disable "$UUID" || true
sleep 0.2
gnome-extensions enable "$UUID" || true

echo "✅ Installazione e hot-reload completati per $UUID!"
