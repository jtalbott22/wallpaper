#!/bin/sh
# Install (or update) the Aether Live Wallpaper GNOME Shell extension.
# (The extension ID still says "mirage" so existing installs keep working.)
#
#   ./install-wallpaper.sh                   install + enable (GPU renderer, Aether)
#   ./install-wallpaper.sh --engine mirage   use the older CPU renderer instead
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

ENGINE=aether
if [ "${1:-}" = "--engine" ]; then
    ENGINE="${2:-aether}"
fi
case "$ENGINE" in aether|mirage) ;; *) echo "unknown engine: $ENGINE (use aether or mirage)"; exit 1 ;; esac

mkdir -p "$DEST"
cp "$REPO/gnome-extension/metadata.json" "$REPO/gnome-extension/extension.js" "$DEST/"
printf '%s\n' "$REPO" > "$DEST/mirage-dir"
printf '%s\n' "$ENGINE" > "$DEST/engine"
echo "Installed to $DEST ($ENGINE renderer, repository $REPO)"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    # Shell already knows about it: toggle to reload the new code.
    gnome-extensions disable "$UUID" 2>/dev/null || true
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
