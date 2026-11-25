#!/bin/bash
# Builds Aether.app from the Swift package, and optionally installs it.
#
#   macos/build.sh                      build macos/build/Aether.app
#   macos/build.sh --install            ...copy it to ~/Applications and open it
#   macos/build.sh --install --open-at-login
#   macos/build.sh --uninstall          quit it, remove the login item and the app
#
# Options: --dest <folder> (default ~/Applications), --universal (arm64 + x86_64,
# needs Xcode), --no-start, --debug.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
dest="$HOME/Applications"
install=0 uninstall=0 login=0 start=1 universal=0 config=release

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
    case "$1" in
        --install) install=1 ;;
        --uninstall) uninstall=1 ;;
        --open-at-login) login=1 ;;
        --no-start) start=0 ;;
        --universal) universal=1 ;;
        --debug) config=debug ;;
        --dest) dest="${2:?--dest needs a folder}"; shift ;;
        -h|--help) usage ;;
        *) echo "unknown option: $1" >&2; usage 1 ;;
    esac
    shift
done

quit_running() {
    pgrep -xq Aether || return 0
    local bin="$1/Contents/MacOS/Aether"
    if [ -x "$bin" ]; then "$bin" --quit; fi
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq Aether || return 0; sleep 0.3; done
    pkill -x Aether || true
}

if [ "$uninstall" = 1 ]; then
    app="$dest/Aether.app"
    if [ -x "$app/Contents/MacOS/Aether" ]; then
        "$app/Contents/MacOS/Aether" --open-at-login off || true
    fi
    quit_running "$app"
    rm -rf "$app"
    echo "Removed $app. Settings stay in ~/Library/Preferences/com.joshuaallentalbott.aether.plist, the log in ~/Library/Logs/Aether."
    exit 0
fi

cd "$here"
arch_args=()
if [ "$universal" = 1 ]; then arch_args=(--arch arm64 --arch x86_64); fi
swift build -c "$config" ${arch_args[@]+"${arch_args[@]}"}
bin_dir="$(swift build -c "$config" ${arch_args[@]+"${arch_args[@]}"} --show-bin-path)"

app="$here/build/Aether.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/Aether" "$app/Contents/MacOS/Aether"
cp "$here/Info.plist" "$app/Contents/Info.plist"
build="$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 1)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build" "$app/Contents/Info.plist"
cp -R "$repo/web" "$app/Contents/Resources/web"
"$here/make-icon.sh" "$app/Contents/Resources/Aether.icns" >/dev/null 2>&1 || echo "note: no app icon ($here/make-icon.sh failed)"
# ad-hoc signature: enough to run on this Mac and to register the login item
codesign --force --sign - --timestamp=none "$app"
echo "Built $app"

if [ "$install" = 1 ]; then
    mkdir -p "$dest"
    target="$dest/Aether.app"
    quit_running "$target"
    rm -rf "$target"
    ditto "$app" "$target"
    echo "Installed to $target"
    if [ "$login" = 1 ]; then "$target/Contents/MacOS/Aether" --open-at-login on; fi
    if [ "$start" = 1 ]; then open "$target"; fi
fi
