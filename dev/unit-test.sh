#!/usr/bin/env bash
# Quick tests that run without GNOME Shell: the usage parsers of the GNOME and browser
# extensions, and the browser's native host. All three must turn the real response in
# dev/fixtures/usage-response.json into dev/fixtures/usage-parsed.json. Also when smart
# quota refresh starts a new session window.
# Usage: dev/unit-test.sh   (needs gjs, python3 and jq; node for the browser extension)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/dev/fixtures"

gjs -m "$REPO/dev/test-account.js"
gjs -m "$REPO/dev/test-quota.js"
if command -v node >/dev/null; then
  node "$REPO/dev/test-browser.mjs"
else
  echo "skip browser extension parser: node not found"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
out="$tmp/claude-meter"
fail() { echo "FAIL native host: $*"; exit 1; }

# Sends the JSON on stdin to the native host the way the browser does.
send() {
  python3 -c 'import struct, sys; m = sys.stdin.buffer.read(); sys.stdout.buffer.write(struct.pack("<I", len(m)) + m)' \
    | XDG_CACHE_HOME="$tmp" python3 "$REPO/native-host/claude_meter_host.py" > "$tmp/reply"
  [ "$(tail -c +5 "$tmp/reply")" = '{"ok": true}' ] || fail "unexpected reply: $(cat "$tmp/reply")"
}

# An older browser extension sends only session and week.
echo '{"five_hour": {"used_percentage": 12, "resets_at": 1793301600}, "seven_day": null, "model": "claude.ai"}' | send
jq -e '.five_hour == {"used_percentage": 12, "resets_at": 1793301600} and .seven_day == null' "$out/usage.json" >/dev/null \
  || fail "usage.json from an older message: $(cat "$out/usage.json")"
[ ! -e "$out/account.json" ] || fail "an older message wrote account.json"

jq -c '. + {model: "claude.ai"}' "$FIXTURES/usage-parsed.json" | send
diff <(jq -S 'del(.updated_at)' "$out/account.json") <(jq -S . "$FIXTURES/usage-parsed.json") \
  || fail "account.json differs from the parsed fixture (above)"
jq -e '.five_hour.used_percentage == 2 and (.updated_at | type) == "number"' "$out/usage.json" >/dev/null \
  || fail "usage.json from a current message: $(cat "$out/usage.json")"

# Anything malformed is dropped rather than passed on to the GNOME extension.
echo '{"five_hour": "x", "plan": 5, "limits": [{"title": 5, "used_percentage": 1}, {"title": "A", "used_percentage": "9"},
  {"title": "B", "used_percentage": 9, "resets_at": true}, null], "extra_usage": "x"}' | send
jq -e '. == {"five_hour": null, "seven_day": null, "plan": null, "updated_at": .updated_at,
  "limits": [{"title": "B", "used_percentage": 9, "resets_at": null}], "extra_usage": null}' "$out/account.json" >/dev/null \
  || fail "malformed message: $(cat "$out/account.json")"
# Without session and week, usage.json keeps the last reading that had them.
jq -e '.five_hour.used_percentage == 2' "$out/usage.json" >/dev/null \
  || fail "a message without session and week replaced usage.json: $(cat "$out/usage.json")"

# A reading with no limit at all changes neither file.
cp "$out/account.json" "$tmp/account.before"
echo '{"five_hour": null, "seven_day": null, "plan": "Pro", "limits": [], "extra_usage": {"enabled": true, "used_percentage": 3}}' | send
cmp -s "$out/account.json" "$tmp/account.before" || fail "a message with no limit replaced account.json: $(cat "$out/account.json")"
jq -e '.five_hour.used_percentage == 2' "$out/usage.json" >/dev/null || fail "a message with no limit replaced usage.json"
echo "ok   native host: usage.json and account.json"
