#!/usr/bin/env bash
# Install Claude Meter: wire the Claude Code status line and the GNOME Shell extension.
# Usage: ./install.sh            install
#        ./install.sh --uninstall remove
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
UUID="claude-meter@atiq-rahman.github.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SETTINGS="$HOME/.claude/settings.json"
STATUSLINE="$REPO/statusline.sh"

command -v jq >/dev/null || { echo "jq is required (sudo apt install jq)"; exit 1; }

enabled_list() { gsettings get org.gnome.shell enabled-extensions; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$EXT_DIR"
  gsettings set org.gnome.shell enabled-extensions \
    "$(enabled_list | sed "s/, '$UUID'//; s/'$UUID', //; s/'$UUID'//")"
  if [ -f "$SETTINGS" ] && [ "$(jq -r '.statusLine.command // ""' "$SETTINGS")" = "$STATUSLINE" ]; then
    jq 'del(.statusLine)' "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
    echo "Removed statusLine from $SETTINGS"
  fi
  echo "Uninstalled. Restart GNOME Shell (X11: Alt+F2, r, Enter; Wayland: log out and back in)."
  exit 0
fi

# 1. Claude Code status line (feeds ~/.cache/claude-meter/usage.json)
chmod +x "$STATUSLINE"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
current=$(jq -r '.statusLine.command // ""' "$SETTINGS")
if [ -n "$current" ] && [ "$current" != "$STATUSLINE" ]; then
  echo "Note: replacing existing status line command: $current"
fi
cp "$SETTINGS" "$SETTINGS.bak"
jq --arg cmd "$STATUSLINE" \
  '.statusLine = {type: "command", command: $cmd, padding: 0, refreshInterval: 30}' \
  "$SETTINGS.bak" > "$SETTINGS"
echo "Configured status line in $SETTINGS (backup: $SETTINGS.bak)"

# 2. GNOME Shell extension
mkdir -p "$(dirname "$EXT_DIR")"
ln -sfn "$REPO/gnome-extension" "$EXT_DIR"
list=$(enabled_list)
if ! grep -q "$UUID" <<<"$list"; then
  if [ "$list" = "@as []" ] || [ "$list" = "[]" ]; then
    new="['$UUID']"
  else
    new="${list%]}, '$UUID']"
  fi
  gsettings set org.gnome.shell enabled-extensions "$new"
fi
echo "Linked extension to $EXT_DIR and enabled it"

echo
echo "Done. Restart GNOME Shell to load the extension:"
echo "  X11:     Alt+F2, type r, Enter"
echo "  Wayland: log out and back in"
echo "Then send any message in Claude Code so the meter gets its first reading."
