#!/usr/bin/env bash
# Smoke test for the GNOME extension: runs GNOME Shell headless on a private D-Bus
# session with its own home, settings, fake usage data, a fake Claude Code login and a
# fake usage API. Checks the session alerts at 90% and 96%, the plan and model limits
# from the API (their alert, the red top bar, the menu rows), the color thresholds, a
# reading from the browser extension's native host, grey rows with a hint once the
# login expires, that an API response without session and week keeps the status
# line's, that a rate-limited API isn't asked again too soon, the move of the old
# settings file to GSettings, the menu's actions and their shortcuts, smart quota
# refresh with a stand-in for Claude Code, the settings window, and Quit lasting until
# the next login. Saves screenshots on the way.
# Usage: dev/smoke-test.sh [extension-dir]   (default: gnome-extension/)
# SMOKE_DIR sets the work directory (default: .dev/smoke).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$(cd "${1:-$REPO/gnome-extension}" && pwd)"
UUID=$(jq -r .uuid "$EXT/metadata.json")
# Turns on unsafe mode, which lets the test drive the shell through org.gnome.Shell.Eval.
# It leaves it on when disabled, as locking the screen disables it.
HELPER="unsafe-mode@smoke-test"
DEV="${SMOKE_DIR:-$REPO/.dev/smoke}"
CACHE="$DEV/cache/claude-meter"
HELPER_DIR="$DEV/data/gnome-shell/extensions/$HELPER"
# Where a Snap Brave runs the native host; the extension reads ~/snap/brave/... too.
SNAP_CACHE="$DEV/home/snap/brave/common/.cache"
EXT_COPY="$DEV/data/gnome-shell/extensions/$UUID"
# Homebrew's builds earlier in PATH may write schemas the shell doesn't read.
COMPILE=$([ -x /usr/bin/glib-compile-schemas ] && echo /usr/bin/glib-compile-schemas || echo glib-compile-schemas)

# FUSE mounts of an interrupted run (the settings window's document portal) block rm.
awk -v dir="$DEV/" 'index($2, dir) == 1 {print $2}' /proc/mounts 2>/dev/null | while read -r mount; do
  fusermount3 -u "$mount" 2>/dev/null || fusermount -u "$mount" 2>/dev/null || true
done
rm -rf "$DEV"
mkdir -p "$CACHE" "$DEV/bin" "$HELPER_DIR" "$DEV/config/glib-2.0/settings" "$DEV/config/claude-meter" "$DEV/runtime" \
  "$DEV/claude" "$SNAP_CACHE" "$DEV/data/applications"
chmod 700 "$DEV/runtime"
# A copy, so the settings schema can be compiled without touching the source.
cp -r "$EXT" "$EXT_COPY"
rm -f "$EXT_COPY/schemas/gschemas.compiled"
"$COMPILE" --strict "$EXT_COPY/schemas"
# Fresh settings: only these extensions enabled, and no welcome tour.
cat > "$DEV/config/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID', '$HELPER']
welcome-dialog-last-shown-version='999'
EOF
# Settings as older versions kept them; the extension moves them to GSettings.
echo '{"account": true}' > "$DEV/config/claude-meter/settings.json"

major=$(gnome-shell --version | sed -nE 's/^GNOME Shell ([0-9]+).*/\1/p')
printf '{"uuid": "%s", "name": "Unsafe mode", "description": "Smoke test helper", "shell-version": ["%s"]}\n' \
  "$HELPER" "$major" > "$HELPER_DIR/metadata.json"
if [ "$major" -ge 45 ]; then
  cat > "$HELPER_DIR/extension.js" <<'EOF'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class UnsafeMode extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
EOF
else
  cat > "$HELPER_DIR/extension.js" <<'EOF'
function init() {
    return {
        enable() { global.context.unsafe_mode = true; },
        disable() {},
    };
}
EOF
fi

# Fake usage API: logs each request's login headers and answers like the real one. The
# word in api.mode changes the answer: "bare" leaves out session and week, and "busy"
# says there were too many requests.
cat > "$DEV/api.py" <<'EOF'
import datetime, http.server, json, sys

dev = sys.argv[1]

def at(hours):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=hours)).isoformat()

def fable(percent):
    return {'kind': 'weekly_scoped', 'group': 'weekly', 'percent': percent, 'resets_at': at(72),
            'scope': {'model': {'id': None, 'display_name': 'Fable'}, 'surface': None}}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(dev + '/api.log', 'a') as log:
            log.write('%s %s %s\n' % (self.path, self.headers.get('Authorization'), self.headers.get('anthropic-beta')))
        try:
            with open(dev + '/api.mode') as f:
                mode = f.read().strip()
        except OSError:
            mode = ''
        if mode == 'busy':
            self.send_response(429)
            self.send_header('Retry-After', '600')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if mode == 'bare':
            body = json.dumps({'limits': [fable(30)]}).encode()
        else:
            body = json.dumps({
                'five_hour': {'utilization': 92.0, 'resets_at': at(2)},
                'seven_day': {'utilization': 40.0, 'resets_at': at(72)},
                'limits': [
                    {'kind': 'session', 'group': 'session', 'percent': 92, 'resets_at': at(2), 'scope': None},
                    {'kind': 'weekly_all', 'group': 'weekly', 'percent': 40, 'resets_at': at(72), 'scope': None},
                    fable(92),
                ],
                'spend': {'used': {'amount_minor': 1250, 'currency': 'USD', 'exponent': 2},
                          'limit': {'amount_minor': 5000, 'currency': 'USD', 'exponent': 2},
                          'percent': 25, 'enabled': True, 'disabled_reason': None},
            }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
with open(dev + '/api.port', 'w') as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
EOF

# Stand-in for paplay: records the alert sound instead of playing it.
printf '#!/bin/sh\necho "$@" >> "%s/paplay.log"\n' "$DEV" > "$DEV/bin/paplay"
chmod +x "$DEV/bin/paplay"

# Stand-in for Claude Code, first in PATH so that smart quota refresh never runs the real
# one: records how it was run, and fails while claude.fail exists.
cat > "$DEV/bin/claude" <<EOF
#!/bin/sh
{ echo "cwd=\$(pwd)"; for arg in "\$@"; do echo "arg=\$arg"; done; echo end; } >> "$DEV/claude.log"
if [ -e "$DEV/claude.fail" ]; then echo "not logged in" >&2; exit 1; fi
echo OK
EOF
chmod +x "$DEV/bin/claude"

# Stand-in for the default text editor, which View logs opens: notes the file it got.
printf '#!/bin/sh\necho "$1" >> "%s/opened"\n' "$DEV" > "$DEV/bin/fake-editor"
chmod +x "$DEV/bin/fake-editor"
cat > "$DEV/data/applications/fake-editor.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Fake editor
Exec=$DEV/bin/fake-editor %f
MimeType=text/plain;text/x-log;application/octet-stream;
EOF
cat > "$DEV/config/mimeapps.list" <<EOF
[Default Applications]
text/plain=fake-editor.desktop
text/x-log=fake-editor.desktop
application/octet-stream=fake-editor.desktop
EOF

fail() {
  echo "FAIL: $*"
  exit 1
}

# Fails unless text $1 contains each of the other arguments.
expect() {
  local text=$1 want
  shift
  for want in "$@"; do
    [[ "$text" == *"$want"* ]] || fail "expected \"$want\" in: $text"
  done
}

fake() { # session% week%
  local now; now=$(date +%s)
  printf '{"five_hour":{"used_percentage":%s,"resets_at":%d},"seven_day":{"used_percentage":%s,"resets_at":%d},"updated_at":%d}\n' \
    "$1" $((now + 7200)) "$2" $((now + 259200)) "$now" > "$CACHE/usage.json"
}

# A status line reading whose session window ended a minute ago.
ended() {
  local now; now=$(date +%s)
  printf '{"five_hour":{"used_percentage":64,"resets_at":%d},"seven_day":{"used_percentage":44,"resets_at":%d},"updated_at":%d}\n' \
    $((now - 60)) $((now + 259200)) "$now" > "$CACHE/usage.json"
}

# Fake Claude Code login that expires in $1 seconds.
login() {
  printf '{"claudeAiOauth":{"accessToken":"test-token","expiresAt":%d000,"rateLimitTier":"default_claude_max_5x","subscriptionType":"max"}}\n' \
    $(($(date +%s) + $1)) > "$DEV/claude/.credentials.json"
}

# Moves updated_at in JSON file $1 back by $2 seconds.
age() {
  jq --argjson s "$2" '.updated_at -= $s' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

# Sends JSON $1 through the browser extension's native host, run the way a Snap browser
# runs it, so the reading lands in that browser's cache.
send_host() {
  python3 -c 'import struct, sys; m = sys.argv[1].encode(); sys.stdout.buffer.write(struct.pack("<I", len(m)) + m)' "$1" \
    | XDG_CACHE_HOME="$SNAP_CACHE" python3 "$REPO/native-host/claude_meter_host.py" >/dev/null
}

# Waits up to $1 seconds for the jq filter $2 to hold for file $3.
wait_for() {
  local i
  for ((i = 0; i < $1 * 2; i++)); do
    jq -e "$2" "$3" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# Waits up to $1 seconds for alerts.json to record session step $2.
wait_step() {
  wait_for "$1" ".five_hour.step == $2" "$CACHE/alerts.json"
}

# Waits up to $1 seconds for the extension's own log, the one View logs opens, to have
# a line with text $2.
wait_log() {
  local i
  for ((i = 0; i < $1 * 2; i++)); do
    grep -qF -- "$2" "$CACHE/claude-meter.log" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

# Waits up to $1 seconds for JavaScript $2 to be true in the shell.
wait_js() {
  local i
  for ((i = 0; i < $1 * 2; i++)); do
    [ "$(shell_eval "$2" 2>/dev/null)" = true ] && return 0
    sleep 0.5
  done
  return 1
}

# Waits up to $1 seconds for the stand-in Claude Code to have run $2 times.
wait_claude() {
  local i
  for ((i = 0; i < $1 * 2; i++)); do
    [ "$(grep -c '^end$' "$DEV/claude.log" 2>/dev/null)" = "$2" ] && return 0
    sleep 0.5
  done
  return 1
}

# Presses Ctrl and the key $1 (a Clutter key name, such as r) on a virtual keyboard.
ctrl_key() {
  shell_eval "
    const {Clutter, GLib} = imports.gi;
    const backend = global.stage.get_context?.().get_backend?.() ?? Clutter.get_default_backend();
    global._smokeKeyboard ??= backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const keyboard = global._smokeKeyboard, now = () => GLib.get_monotonic_time();
    keyboard.notify_keyval(now(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_$1, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_$1, Clutter.KeyState.RELEASED);
    keyboard.notify_keyval(now(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    true;" >/dev/null
}

# The shell only takes screenshots for a few callers, gsd-media-keys among them;
# nothing owns that name on this private bus, so borrow it.
screenshot() {
  gjs -c "
    const {Gio, GLib} = imports.gi;
    const bus = Gio.DBus.session;
    bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
        new GLib.Variant('(su)', ['org.gnome.SettingsDaemon.MediaKeys', 4]), null, 0, -1, null);
    bus.call_sync('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
        'Screenshot', new GLib.Variant('(bbs)', [false, false, '$1']), null, 0, 10000, null);"
}

# Runs JavaScript in the shell and prints the JSON-encoded result.
shell_eval() {
  gjs -c "
    const {Gio, GLib} = imports.gi;
    const [ok, result] = Gio.DBus.session.call_sync('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
        new GLib.Variant('(s)', [ARGV[0]]), null, 0, 10000, null).deepUnpack();
    print(result);
    if (!ok) imports.system.exit(1);" "$1"
}

# The indicator, in JavaScript run in the shell.
IND='Main.panel.statusArea["claude-meter"]'
# Opens the indicator's menu and lists the text it shows, each with its style class in
# brackets, then the top bar's style.
MENU_DUMP='
const i = Main.panel.statusArea["claude-meter"];
i.menu.open(false);
const out = [];
const walk = a => {
    if (!a.visible) return;
    if (a.constructor.$gtype.name === "ClutterText" && a.text) {
        const cls = a.get_parent().style_class;
        out.push(cls ? a.text + "[" + cls + "]" : a.text);
    }
    a.get_children().forEach(walk);
};
walk(i.menu.box);
out.join(" | ") + " || panel[" + i._box.style_class + "]";'
# Lets the indicator try the usage API again, as a promise for menu_dump.
REFETCH='(j => {
    j._lastFetch = 0;
    return j._fetchAccount(300);
})(Main.panel.statusArea["claude-meter"])'
# Asks the indicator to fetch now, however recent its last fetch.
FETCH_NOW='Main.panel.statusArea["claude-meter"]._fetchAccount(0);'
# Seconds until the indicator may ask the usage API again.
RETRY_IN='Main.panel.statusArea["claude-meter"]._retryAt - Math.floor(Date.now() / 1000);'

# Waits for the promise of JavaScript $1, if given, then for a refresh of the indicator,
# which reads its files without blocking, and prints MENU_DUMP's list.
menu_dump() {
  shell_eval "global._smokeDone = false;
    Promise.resolve(${1:-null}).then(() => $IND._refresh()).finally(() => { global._smokeDone = true; });
    true" >/dev/null || return 1
  wait_js 10 'global._smokeDone === true' || { echo "the refresh did not finish"; return 1; }
  shell_eval "$MENU_DUMP"
}

# Runs inside the private D-Bus session: starts the shell and checks the extension.
checks() {
  gnome-shell --headless --no-x11 --virtual-monitor 1280x800 >"$DEV/shell.log" 2>&1 &
  local shell=$! menu now
  trap "kill $shell 2>/dev/null; wait $shell 2>/dev/null" EXIT
  wait_step 60 90 || fail "no 90% alert"
  echo "ok   $(gnome-shell --version), extension state: $(gnome-extensions info "$UUID" | sed -n "s/^ *State: //p")"
  echo "ok   90% alert fired"
  wait_for 20 'any(.limits[]; .title == "Week · Fable")' "$CACHE/account.json" || fail "account usage not fetched"
  grep -q "Bearer test-token oauth-2025-04-20" "$DEV/api.log" || fail "usage API request lacked the login headers"
  echo "ok   account usage fetched with the Claude Code login"
  wait_for 20 '."limit:Week · Fable".step == 90' "$CACHE/alerts.json" || fail "no alert for the Fable weekly limit at 92%"
  echo "ok   Fable weekly limit at 92% alerted"
  fake 96 40
  wait_step 20 96 || fail "96% alert did not update"
  echo "ok   96% alert updated the same notification"
  sleep 1
  screenshot "$DEV/screenshot.png" >/dev/null && echo "ok   screenshot: $DEV/screenshot.png"

  menu=$(menu_dump) || fail "could not open the menu: $menu"
  expect "$menu" "Week · Fable[claude-meter-row-title] | 92%[claude-meter-crit]" \
    "Extra usage[claude-meter-row-title] | 25%[claude-meter-ok]" "\$12.50 of \$50.00 used" "Max (5x) · updated"
  echo "ok   menu shows the plan, the Fable weekly limit and extra usage"
  sleep 1
  screenshot "$DEV/menu.png" >/dev/null && echo "ok   screenshot: $DEV/menu.png"

  fake 20 40
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Session (5 hours)[claude-meter-row-title] | 20%[claude-meter-ok]" \
    "panel[claude-meter-panel claude-meter-panel-crit]"
  echo "ok   top bar turns red for the Fable limit alone"

  # Green below 75%, yellow from 75%, red from 90%. Session is past its alerts already,
  # and week stays below its first one, so no alert fires.
  local colors
  fake 89 74
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Session (5 hours)[claude-meter-row-title] | 89%[claude-meter-warn]" \
    "Week (7 days)[claude-meter-row-title] | 74%[claude-meter-ok]"
  colors=$(shell_eval "$IND._sLabel.style_class + ' ' + $IND._wLabel.style_class")
  [ "$colors" = '"claude-meter-warn claude-meter-ok"' ] || fail "top bar at 89% and 74%: $colors"
  fake 90 75
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Session (5 hours)[claude-meter-row-title] | 90%[claude-meter-crit]" \
    "Week (7 days)[claude-meter-row-title] | 75%[claude-meter-warn]"
  colors=$(shell_eval "$IND._sLabel.style_class + ' ' + $IND._wLabel.style_class")
  [ "$colors" = '"claude-meter-crit claude-meter-warn"' ] || fail "top bar at 90% and 75%: $colors"
  fake 20 40
  echo "ok   values turn yellow from 75% and red from 90%, in the top bar and the menu"

  now=$(date +%s)
  send_host "{\"five_hour\": {\"used_percentage\": 20, \"resets_at\": $((now + 7200))},
    \"seven_day\": {\"used_percentage\": 40, \"resets_at\": $((now + 259200))}, \"model\": \"claude.ai\", \"plan\": \"Pro\",
    \"limits\": [{\"title\": \"Week · Fable\", \"used_percentage\": 50, \"resets_at\": $((now + 259200))}],
    \"extra_usage\": {\"enabled\": false, \"used_percentage\": 0, \"used\": \"\$0.00\", \"limit\": null, \"reason\": \"out_of_credits\"}}"
  [ -f "$SNAP_CACHE/claude-meter/account.json" ] || fail "the native host wrote no account.json"
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Week · Fable[claude-meter-row-title] | 50%[claude-meter-ok]" "Off[claude-meter-stale]" \
    "Out of credits[claude-meter-row-sub]" "Pro · updated" "panel[claude-meter-panel]"
  echo "ok   a reading from the browser extension's native host shows in the menu"

  login -60
  age "$CACHE/account.json" 1300
  age "$SNAP_CACHE/claude-meter/account.json" 1200
  menu=$(menu_dump "$REFETCH") || fail "menu: $menu"
  expect "$menu" "Week · Fable[claude-meter-row-title] | 50%[claude-meter-stale]" \
    "Claude Code login expired - open Claude Code[claude-meter-footer]" "panel[claude-meter-panel]"
  [[ "$menu" != *"Session (5 hours)[claude-meter-row-title] | 20%[claude-meter-stale]"* ]] || fail "fresh session row went grey"
  echo "ok   limits older than 15 minutes turn grey, and the expired login is explained"
  sleep 1
  screenshot "$DEV/stale.png" >/dev/null && echo "ok   screenshot: $DEV/stale.png"

  # The API's reading must be newer than the status line's, so wait a second first.
  fake 33 44
  sleep 1
  echo bare > "$DEV/api.mode"
  login 86400
  shell_eval "$FETCH_NOW" >/dev/null || fail "could not ask for a fetch"
  wait_for 20 '.five_hour == null and .seven_day == null and .limits[0].used_percentage == 30' "$CACHE/account.json" \
    || fail "the reading without session and week was not saved: $(cat "$CACHE/account.json")"
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Session (5 hours)[claude-meter-row-title] | 33%[claude-meter-ok]" \
    "Week (7 days)[claude-meter-row-title] | 44%[claude-meter-ok]" "Week · Fable[claude-meter-row-title] | 30%[claude-meter-ok]"
  echo "ok   an API reading without session and week keeps the status line's"

  echo busy > "$DEV/api.mode"
  local requests wait i
  requests=$(wc -l < "$DEV/api.log")
  shell_eval "$FETCH_NOW" >/dev/null || fail "could not ask for a fetch"
  for ((i = 0; i < 40; i++)); do
    wait=$(shell_eval "$RETRY_IN") && [ "$wait" -gt 0 ] && break
    sleep 0.5
  done
  [ "$wait" -ge 590 ] && [ "$wait" -le 600 ] || fail "expected to wait the 600 seconds Retry-After asks, not $wait"
  shell_eval "$FETCH_NOW" >/dev/null || fail "could not ask for a fetch"
  menu_dump >/dev/null || fail "could not open the menu"
  sleep 1
  [ "$(wc -l < "$DEV/api.log")" -eq $((requests + 1)) ] || fail "asked the rate-limited API again: $(tail -3 "$DEV/api.log")"
  echo "ok   a rate-limited API is asked again only after its Retry-After"
  rm "$DEV/api.mode"

  [ ! -e "$DEV/config/claude-meter/settings.json" ] || fail "the old settings file is still there"
  [ "$(shell_eval "$IND._settings.get_boolean('plan-and-model-limits')")" = true ] \
    || fail "plan and model limits did not move from the old settings file to GSettings"
  echo "ok   the old settings file moved to GSettings"

  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Refresh now | Ctrl+R[claude-meter-shortcut]" "Smart quota refresh" \
    "Starts a new window when one ends[claude-meter-footer claude-meter-hint]" "Settings… | Ctrl+,[claude-meter-shortcut]" \
    "View logs" "Version 1.0.0[claude-meter-footer]" "Quit Claude Meter | Ctrl+Q[claude-meter-shortcut]"
  [[ "$menu" != *"Show Session (S)"* ]] || fail "the old Settings submenu is still there"
  echo "ok   the menu has Refresh now, Smart quota refresh, Settings…, View logs, the version and Quit"
  sleep 1
  screenshot "$DEV/actions.png" >/dev/null && echo "ok   screenshot: $DEV/actions.png"

  ctrl_key r
  wait_log 10 "Refresh now" || fail "Ctrl+R did not refresh"
  [ "$(shell_eval "$IND.menu.isOpen")" = true ] || fail "Ctrl+R closed the menu"
  echo "ok   Ctrl+R refreshes and leaves the menu open"

  shell_eval "$IND.menu._getMenuItems().find(m => m.label && m.label.text === 'View logs').activate(null)" >/dev/null \
    || fail "could not choose View logs"
  for ((i = 0; i < 20; i++)); do grep -qxF "$CACHE/claude-meter.log" "$DEV/opened" 2>/dev/null && break; sleep 0.5; done
  grep -qxF "$CACHE/claude-meter.log" "$DEV/opened" 2>/dev/null \
    || fail "View logs did not open $CACHE/claude-meter.log: $(cat "$DEV/opened" 2>/dev/null)"
  echo "ok   View logs opens the log in the default text editor"

  # Past 256 KB the log starts over, keeping the previous one as claude-meter.log.old.
  echo "old log" > "$CACHE/claude-meter.log.old"
  head -c 300000 /dev/zero | tr '\0' 'x' >> "$CACHE/claude-meter.log"
  shell_eval "$IND._refreshNow(); true" >/dev/null || fail "could not refresh"
  for ((i = 0; i < 20; i++)); do [ "$(stat -c %s "$CACHE/claude-meter.log" 2>/dev/null || echo 0)" -lt 1000 ] && break; sleep 0.5; done
  [ "$(stat -c %s "$CACHE/claude-meter.log")" -lt 1000 ] && grep -q "Refresh now" "$CACHE/claude-meter.log" \
    || fail "the log did not start over: $(stat -c %s "$CACHE/claude-meter.log") bytes"
  [ "$(stat -c %s "$CACHE/claude-meter.log.old")" -gt 300000 ] || fail "the full log was not kept as claude-meter.log.old"
  echo "ok   a log past 256 KB starts over, keeping the previous one"

  # Smart quota refresh starts a new window through Claude Code once the last one ended.
  ended
  shell_eval "$IND._smartSwitch.toggle()" >/dev/null || fail "could not turn on smart quota refresh"
  wait_claude 20 1 || fail "smart quota refresh did not run Claude Code: $(tail -3 "$CACHE/claude-meter.log")"
  expected=$(printf '%s\n' "cwd=$CACHE" 'arg=-p' 'arg=Reply with OK.' 'arg=--model' 'arg=haiku' 'arg=--tools' 'arg=' \
    'arg=--no-session-persistence' 'arg=--strict-mcp-config' 'arg=--disable-slash-commands' 'arg=--settings' \
    'arg={"disableAllHooks": true}' end)
  [ "$(cat "$DEV/claude.log")" = "$expected" ] || fail "Claude Code ran with: $(cat "$DEV/claude.log")"
  [ "$(shell_eval "$IND._settings.get_boolean('smart-quota-refresh')")" = true ] || fail "the switch did not turn on the setting"
  wait_for 10 '.started_at > 0 and .started_at >= .tried_at' "$CACHE/smart-refresh.json" \
    || fail "no new window noted: $(cat "$CACHE/smart-refresh.json")"
  wait_log 10 "Smart quota refresh: started a new session window" || fail "the new window is not in the log"
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Started a new window at"
  shell_eval "$IND._refresh(); $IND._refresh(); true" >/dev/null
  sleep 1
  wait_claude 1 1 || fail "smart quota refresh ran Claude Code again while its window runs"
  echo "ok   smart quota refresh starts a new window through Claude Code, once"

  touch "$DEV/claude.fail"
  shell_eval "$IND._smart = {started_at: 0, tried_at: 0}; $IND._refresh(); true" >/dev/null
  wait_claude 20 2 || fail "smart quota refresh did not try again"
  wait_log 10 "failed: not logged in" || fail "the failure is not in the log: $(tail -3 "$CACHE/claude-meter.log")"
  menu=$(menu_dump) || fail "menu: $menu"
  expect "$menu" "Could not start a window - see View logs[claude-meter-footer claude-meter-hint]"
  shell_eval "$IND._refresh(); true" >/dev/null
  sleep 1
  wait_claude 1 2 || fail "smart quota refresh retried a failure right away"
  rm "$DEV/claude.fail"
  shell_eval "$IND._settings.set_boolean('smart-quota-refresh', false)" >/dev/null
  [ "$(shell_eval "$IND._smartSwitch.state")" = false ] || fail "the switch did not follow the setting"
  echo "ok   a failed smart quota refresh is shown and not retried right away"

  shell_eval "$IND._settings.set_boolean('show-session', false)" >/dev/null
  [ "$(shell_eval "$IND._sLabel.visible")" = false ] || fail "Show Session (S) off still shows S"
  shell_eval "$IND._settings.set_boolean('show-session', true)" >/dev/null
  shell_eval "$IND._settings.set_string('position', 'left')" >/dev/null
  wait_js 10 "Main.panel._leftBox.contains($IND?.container ?? null)" || fail "did not move to the left"
  shell_eval "$IND._settings.set_string('position', 'right')" >/dev/null
  wait_js 10 "Main.panel._rightBox.contains($IND?.container ?? null)" || fail "did not move back to the right"
  echo "ok   changed settings apply right away"

  # The settings window is an app on this shell's display, started through D-Bus.
  dbus-update-activation-environment WAYLAND_DISPLAY="$(cd "$XDG_RUNTIME_DIR" && ls -d wayland-[0-9]* | grep -v lock | head -1)"
  shell_eval "$IND.menu.open(false)" >/dev/null
  ctrl_key comma
  wait_js 30 "global.get_window_actors().some(a => a.meta_window.get_title() === 'Claude Meter')" \
    || fail "Ctrl+, did not open the settings window"
  [ "$(shell_eval "$IND.menu.isOpen")" = false ] || fail "the menu stayed open over the settings window"
  shell_eval "global.get_window_actors().find(a => a.meta_window.get_title() === 'Claude Meter')
      .meta_window.activate(global.display.get_current_time_roundtrip())" >/dev/null
  sleep 2
  screenshot "$DEV/settings.png" >/dev/null && echo "ok   screenshot: $DEV/settings.png"
  shell_eval "global.get_window_actors().find(a => a.meta_window.get_title() === 'Claude Meter')
      .meta_window.delete(global.display.get_current_time_roundtrip())" >/dev/null
  wait_js 10 "!global.get_window_actors().some(a => a.meta_window.get_title() === 'Claude Meter')" \
    || fail "the settings window did not close"
  echo "ok   Ctrl+, opens the settings window"

  shell_eval "$IND.menu.open(false)" >/dev/null
  ctrl_key q
  wait_js 10 "!$IND" || fail "Ctrl+Q did not hide Claude Meter"
  wait_log 5 "Quit: hidden until the next login" || fail "Quit is not in the log"
  # Locking the screen disables and enables extensions; Quit lasts through that.
  local starts
  starts=$(grep -c ' on GNOME Shell ' "$CACHE/claude-meter.log")
  shell_eval "Main.sessionMode.pushMode('unlock-dialog')" >/dev/null || fail "could not lock"
  sleep 1
  shell_eval "Main.sessionMode.popMode('unlock-dialog')" >/dev/null || fail "could not unlock"
  for ((i = 0; i < 20; i++)); do
    [ "$(grep -c ' on GNOME Shell ' "$CACHE/claude-meter.log")" -gt "$starts" ] && break
    sleep 0.5
  done
  [ "$(grep -c ' on GNOME Shell ' "$CACHE/claude-meter.log")" -gt "$starts" ] || fail "locking did not disable and enable the extension"
  sleep 1
  [ "$(shell_eval "!!$IND")" = false ] || fail "Claude Meter came back after locking the screen"
  gnome-extensions disable "$UUID"
  gnome-extensions enable "$UUID"
  wait_js 10 "!!$IND" || fail "switching it off and on did not bring Claude Meter back"
  echo "ok   Ctrl+Q hides Claude Meter until it's switched off and on, also when the screen locks"
}

pids=()
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
python3 "$DEV/api.py" "$DEV" &
pids+=($!)
for ((i = 0; i < 50; i++)); do [ -s "$DEV/api.port" ] && break; sleep 0.1; done
[ -s "$DEV/api.port" ] || fail "the fake usage API did not start"

fake 92 40
login 86400
export HOME="$DEV/home" XDG_CACHE_HOME="$DEV/cache" XDG_CONFIG_HOME="$DEV/config" XDG_DATA_HOME="$DEV/data" \
  XDG_RUNTIME_DIR="$DEV/runtime" GSETTINGS_BACKEND=keyfile GVFS_DISABLE_FUSE=1 PATH="$DEV/bin:$PATH" \
  CLAUDE_CONFIG_DIR="$DEV/claude" CLAUDE_METER_USAGE_API="http://127.0.0.1:$(cat "$DEV/api.port")/api/oauth/usage"
export -f fail expect fake ended login age send_host wait_for wait_step wait_log wait_js wait_claude ctrl_key \
  screenshot shell_eval menu_dump checks
export REPO DEV UUID CACHE SNAP_CACHE IND MENU_DUMP REFETCH FETCH_NOW RETRY_IN

# Containers have no system bus, and the shell won't start without one.
if [ ! -S /run/dbus/system_bus_socket ]; then
  { read -r DBUS_SYSTEM_BUS_ADDRESS; read -r sysbus_pid; } < <(dbus-daemon --session --fork --print-address=1 --print-pid=1)
  export DBUS_SYSTEM_BUS_ADDRESS
  pids+=("$sysbus_pid")
fi

set +e
# The session's own output, which includes the settings window's.
/usr/bin/dbus-run-session -- bash -c checks 2>"$DEV/session.log"
status=$?
set -e

echo "sounds: $(cat "$DEV/paplay.log" 2>/dev/null | tr '\n' ' ')"
# The extension's own messages, and stack traces through its files. The rate-limited
# fetch above is logged on purpose.
if grep -F -e "$UUID" -e 'claude-meter:' "$DEV/shell.log" | grep -v 'could not fetch account usage: HTTP 429$'; then
  echo "FAIL: extension errors above, full log: $DEV/shell.log"
  exit 1
fi
if grep -E -A6 'Gjs-CRITICAL|JS ERROR' "$DEV/session.log"; then
  echo "FAIL: JavaScript errors in the settings window above, full log: $DEV/session.log"
  exit 1
fi
[ "$status" = 0 ] || { echo "FAIL, see $DEV/shell.log"; exit "$status"; }
echo "PASS"
