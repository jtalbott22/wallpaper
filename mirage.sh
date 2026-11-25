#!/bin/sh
# Launch Mirage from the repository directory.
# Usage: ./mirage.sh [--windowed|--fullscreen] [other python3 -m mirage options]
set -eu
cd "$(dirname "$0")"
exec python3 -m mirage "$@"
