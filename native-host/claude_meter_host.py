#!/usr/bin/env python3
"""Native messaging host for Usage Meter for Claude.

The browser extension sends each usage reading here; this writes it to the same cache
file the Claude Code status line uses, so the GNOME extension shows it in the top bar.
"""
import json
import os
import struct
import sys
import time

CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                     "claude-meter", "usage.json")


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


def window(w):
    if not isinstance(w, dict) or not isinstance(w.get("used_percentage"), (int, float)):
        return None
    reset = w.get("resets_at")
    return {"used_percentage": w["used_percentage"],
            "resets_at": int(reset) if isinstance(reset, (int, float)) else None}


def main():
    msg = read_message()
    if msg is None:
        return
    if msg.get("ping"):
        send_message({"ok": True})
        return
    data = {
        "five_hour": window(msg.get("five_hour")),
        "seven_day": window(msg.get("seven_day")),
        "model": "claude.ai",
        "updated_at": int(time.time()),
    }
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, CACHE)
    send_message({"ok": True})


if __name__ == "__main__":
    main()
