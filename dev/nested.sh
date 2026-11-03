#!/usr/bin/env bash
# Runs GNOME Shell in a window with Claude Meter and the fake reading of `make fake`.
# Settings and extensions live in .dev/nested, and the session gets a runtime
# directory of its own, so your real top bar, settings, enabled extensions and
# desktop services are left alone. There is no Claude Code login in there, so the
# plan and model limits come from `make fake` too, never from the real usage API.
#
# After editing gnome-extension/, close the window and run it again.
# Usage: dev/nested.sh [extension-dir]   (default: gnome-extension/; the Makefile
# passes build/legacy on GNOME 42-44)
# NESTED_FLAGS replaces the window flags, e.g. for a quick headless check:
#   NESTED_FLAGS="--headless --virtual-monitor 1280x800" dev/nested.sh
# NESTED_DIR replaces .dev/nested.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$(cd "${1:-$REPO/gnome-extension}" && pwd)"
UUID=$(sed -nE 's/.*"uuid": *"([^"]+)".*/\1/p' "$EXT/metadata.json")
DEV="${NESTED_DIR:-$REPO/.dev/nested}"
# Where `make fake` writes the reading.
CACHE="$REPO/.dev/cache"
EXTENSIONS="$DEV/data/gnome-shell/extensions"
KEYFILE="$DEV/config/glib-2.0/settings/keyfile"
# Homebrew's builds earlier in PATH can't start GNOME Shell.
DBUS_RUN=$([ -x /usr/bin/dbus-run-session ] && echo /usr/bin/dbus-run-session || echo dbus-run-session)
DEVKIT=/usr/libexec/mutter-devkit

major=$(gnome-shell --version | sed -nE 's/^GNOME Shell ([0-9]+).*/\1/p')
# GNOME 49 replaced the --nested window with the mutter-devkit viewer.
if [ -n "${NESTED_FLAGS:-}" ]; then
  flags=$NESTED_FLAGS
elif [ "$major" -ge 49 ]; then
  [ -x "$DEVKIT" ] || { echo "Needs $DEVKIT: sudo apt install mutter-dev-bin"; exit 1; }
  flags="--devkit --wayland"
else
  flags="--nested --wayland"
fi

[ -f "$EXT/schemas/gschemas.compiled" ] || { echo "Compile the schema first: make schemas"; exit 1; }

# The nested session gets a runtime directory of its own. In yours, the
# services it starts would take over your desktop's: its document portal
# replaces the /run/user/<uid>/doc mount and unmounts it when it quits, and
# a nested shell that doesn't shut down cleanly leaves the marker behind that
# makes GNOME disable all extensions after a crash. Only the window needs your
# desktop: it gets your display's socket by its full path, and on GNOME 49+ the
# picture travels through your PipeWire, as a client like any screen recorder.
RUNTIME="$DEV/runtime"
host_runtime=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
awk -v dir="$RUNTIME/" 'index($2, dir) == 1 {print $2}' /proc/mounts | while read -r mount; do
  fusermount3 -u "$mount" 2>/dev/null || fusermount -u "$mount" 2>/dev/null || true
done
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"
chmod 700 "$RUNTIME"
host_display=${WAYLAND_DISPLAY:-wayland-0}
[[ $host_display == /* ]] || host_display="$host_runtime/$host_display"

mkdir -p "$EXTENSIONS" "$(dirname "$KEYFILE")" "$CACHE"
ln -sfn "$EXT" "$EXTENSIONS/$UUID"
# The file indexer, which the shell's search can start, would index your home
# folder into .dev/cache, so give it nothing to index.
if [ ! -f "$KEYFILE" ]; then
  cat > "$KEYFILE" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
welcome-dialog-last-shown-version='999'

[org/freedesktop/tracker/miner/files]
index-recursive-directories=@as []
index-single-directories=@as []
index-removable-devices=false
index-optical-discs=false
EOF
fi

echo "GNOME Shell $major in a window with $UUID; settings in $DEV, reading in $CACHE"
export XDG_CONFIG_HOME="$DEV/config" XDG_DATA_HOME="$DEV/data" XDG_CACHE_HOME="$CACHE" \
  XDG_RUNTIME_DIR="$RUNTIME" WAYLAND_DISPLAY="$host_display" PIPEWIRE_RUNTIME_DIR="$host_runtime" \
  GSETTINGS_BACKEND=keyfile GVFS_DISABLE_FUSE=1 MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 \
  CLAUDE_CONFIG_DIR="$CACHE/no-login" NESTED_FLAGS="$flags" DEV
# Apps started from inside (the settings window, View logs) would open on your
# desktop, whose display the session inherited. Once the nested shell has its
# own Wayland socket, point them at that instead.
exec "$DBUS_RUN" -- bash -c '
  sockets() { ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E "^wayland-[0-9]+$"; }
  before=$(sockets)
  gnome-shell $NESTED_FLAGS &
  shell=$!
  for _ in $(seq 100); do
    own=$(sockets | grep -vxF "$before" | head -1)
    [ -n "$own" ] && break
    sleep 0.1
  done
  [ -z "$own" ] || dbus-update-activation-environment WAYLAND_DISPLAY="$own"
  wait "$shell"'
