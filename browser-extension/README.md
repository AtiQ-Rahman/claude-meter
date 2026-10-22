# Usage Meter for Claude

Your real claude.ai session and weekly usage limits in the browser, with sound alerts before you run out. Works in Chrome, Brave, Edge and other Chromium browsers.

> Unofficial community project. Not affiliated with or endorsed by Anthropic.

## What it does

- **Real limits, not estimates.** Reads the same numbers claude.ai shows on Settings > Usage: the 5-hour session limit, the weekly limit, and any model-specific weekly limits on your plan.
- **Live toolbar icon.** The icon is a ring that fills up with your usage, green, then yellow at 80% and red at 90%. A badge shows the exact percentage.
- **Meter on claude.ai.** A small pill in the corner of the page shows Session, Week and messages left while you write.
- **Messages left.** Learns how much one of your messages usually costs and estimates how many you have left, for example "About 14 messages left".
- **Alerts with sound** at 80% and 90%, then at every percent from 95%, for each limit. The 90% alert stays on screen until you dismiss it. Sounds play even when no claude.ai tab is open.
- **Pace forecast.** From your last hour of use it estimates when you will hit 100%, and warns you if that is less than 30 minutes away and before the limit resets.
- **Reset notice** right when a limit you were warned about resets.
- **Quiet hours** that silence sounds but keep notifications.
- **7-day history chart** of session and weekly usage.
- **Linux top bar (optional).** Feeds the [Claude Meter](../) GNOME extension, so the top bar works without Claude Code.
- **Private.** No servers, no analytics, no account. The only requests go to claude.ai, using your existing login. See [PRIVACY.md](PRIVACY.md).

Thresholds, sounds, volume, quiet hours, the badge, the icon ring and the page meter are all adjustable in Settings.

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `browser-extension` folder.
5. Make sure you are logged in to claude.ai, then click the extension icon in the toolbar. Pin it to keep the meter visible.

## Show it in the GNOME top bar

1. Install [Claude Meter](../) with `./install.sh`.
2. In the extension's Settings, under **Linux top bar**, copy the command shown (it includes this extension's ID) and run it in the repository folder, for example `./install.sh --browser abcdefghijklmnopabcdefghijklmnop`.
3. Restart the browser, turn on **Send readings to the GNOME top bar**, allow the permission, and press **Test connection**.

This uses the optional `nativeMessaging` permission, which is only requested when you turn it on.

## How it works

The background worker asks claude.ai for your organization and its usage every 2 minutes, about 30 seconds after you send a message on claude.ai, and right after a limit resets. If the direct request is blocked, it makes the same request from an open claude.ai tab.

claude.ai does not document this data, so it can change without notice. If the popup shows an error, open **Settings > Diagnostics** to see what claude.ai returned, and please open an issue.

## Permissions

| Permission | Why |
| --- | --- |
| `claude.ai` access | Read your usage with your existing login, and show the page meter |
| `storage` | Settings, the latest reading, and 7 days of history |
| `alarms` | Check usage on a schedule and right after a reset |
| `notifications` | Alerts |
| `offscreen` | Play alert sounds (background workers can't play audio) |
| `nativeMessaging` (optional) | Only if you turn on the GNOME top bar |

## Publishing

`./package.sh` builds `dist/usage-meter-for-claude-<version>.zip` for the Chrome Web Store. The privacy policy for the listing is [PRIVACY.md](PRIVACY.md).
