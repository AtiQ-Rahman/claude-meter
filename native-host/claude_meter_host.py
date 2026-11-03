#!/usr/bin/env python3
"""Native messaging host for Usage Meter for Claude.

The browser extension sends each usage reading here; this writes it to the same cache
file the Claude Code status line uses, so the GNOME extension shows it in the top bar.
The plan, per-model limits and extra usage go to account.json next to it, for the GNOME
extension's "Plan and model limits". They get their own file because the status line
rewrites usage.json without them.
"""
import json
import math
import os
import struct
import sys
import time

CACHE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "claude-meter")
CACHE = os.path.join(CACHE_DIR, "usage.json")
ACCOUNT = os.path.join(CACHE_DIR, "account.json")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send_message(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def number(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if math.isfinite(v) else None


def text(v):
    return v if isinstance(v, str) and v else None


def window(w):
    if not isinstance(w, dict) or not isinstance(w.get("used_percentage"), (int, float)):
        return None
    reset = w.get("resets_at")
    return {"used_percentage": w["used_percentage"],
            "resets_at": int(reset) if isinstance(reset, (int, float)) else None}


def limit(l):
    if not isinstance(l, dict) or text(l.get("title")) is None or number(l.get("used_percentage")) is None:
        return None
    reset = number(l.get("resets_at"))
    return {"title": l["title"], "used_percentage": l["used_percentage"],
            "resets_at": int(reset) if reset is not None else None}


def extra_usage(e):
    if not isinstance(e, dict):
        return None
    return {"enabled": e.get("enabled") is True, "used_percentage": number(e.get("used_percentage")),
            "used": text(e.get("used")), "limit": text(e.get("limit")), "reason": text(e.get("reason"))}


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def main():
    msg = read_message()
    if not isinstance(msg, dict):
        return
    if msg.get("ping"):
        send_message({"ok": True})
        return
    now = int(time.time())
    five_hour = window(msg.get("five_hour"))
    seven_day = window(msg.get("seven_day"))
    os.makedirs(CACHE_DIR, exist_ok=True)
    # A reading without session and week would only replace the status line's.
    if five_hour or seven_day:
        write_json(CACHE, {"five_hour": five_hour, "seven_day": seven_day, "model": "claude.ai", "updated_at": now})
    # Browser extension versions from before account.json don't send "limits".
    if "limits" in msg:
        limits = [x for x in map(limit, msg["limits"] if isinstance(msg["limits"], list) else []) if x]
        if five_hour or seven_day or limits:
            write_json(ACCOUNT, {
                "five_hour": five_hour,
                "seven_day": seven_day,
                "plan": text(msg.get("plan")),
                "limits": limits,
                "extra_usage": extra_usage(msg.get("extra_usage")),
                "updated_at": now,
            })
    send_message({"ok": True})


if __name__ == "__main__":
    main()
