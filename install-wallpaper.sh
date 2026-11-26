#!/bin/sh
# Install (or update) the Aether Live Wallpaper GNOME Shell extension.
# (The extension ID still says "mirage" so existing installs keep working.)
#
#   ./install-wallpaper.sh                   install + enable (the web engine, as on macOS and Windows)
#   ./install-wallpaper.sh --engine aether   use the native GPU renderer (10 scenes) instead
#   ./install-wallpaper.sh --engine mirage   use the older CPU renderer instead
#
# The web engine runs best with WebKitGTK 6.0 (sudo apt install gir1.2-webkit-6.0)
# and also works with WebKitGTK 4.1 (gir1.2-webkit2-4.1, on Ubuntu by default);
# with neither, the extension falls back to the native renderer on its own.
# The top bar menu can switch renderers at any time.
#   ./install-wallpaper.sh --uninstall
#
# On Wayland, GNOME Shell only discovers a newly installed extension at
# login, so log out and back in once after the first install.
set -eu

UUID="mirage-wallpaper@mirage.local"
REPO="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ "${1:-}" = "--uninstall" ]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    echo "Removed $DEST. Log out and back in to fully unload it."
    exit 0
fi

ENGINE=web
if [ "${1:-}" = "--engine" ]; then
    ENGINE="${2:-web}"
fi
case "$ENGINE" in web|aether|mirage) ;; *) echo "unknown engine: $ENGINE (use web, aether or mirage)"; exit 1 ;; esac

mkdir -p "$DEST"
cp "$REPO/gnome-extension/metadata.json" "$REPO/gnome-extension/extension.js" "$DEST/"
mkdir -p "$DEST/icons"
cp "$REPO/gnome-extension/icons/"*.svg "$DEST/icons/"
printf '%s\n' "$REPO" > "$DEST/mirage-dir"
printf '%s\n' "$ENGINE" > "$DEST/engine"
echo "Installed to $DEST ($ENGINE renderer, repository $REPO)"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    # Shell already knows about it: toggle to reload the new code.
    gnome-extensions disable "$UUID" 2>/dev/null || true
    sleep 1   # enabling straight after disabling can leave it inactive
    gnome-extensions enable "$UUID"
    echo "Enabled. On Wayland, extension.js changes need a log out/in; a renderer switch applies the next time it restarts (also at login)."
else
    # Not discovered yet (fresh install on Wayland): add it to the enabled
    # list so it starts automatically at next login.
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    case "$current" in
        *"'$UUID'"*) ;;
        "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']" ;;
    esac
    echo "Log out and back in; the wallpaper will start automatically."
fi
