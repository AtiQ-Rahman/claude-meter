# Claude Meter for the browser

Your real claude.ai session and weekly usage limits in the browser toolbar, with sound alerts before you run out. Works in Chrome, Brave, Edge and other Chromium browsers.

> Unofficial community project. Not affiliated with or endorsed by Anthropic.

## What it does

- **Real limits, not estimates.** Reads the same numbers claude.ai shows on Settings > Usage: the 5-hour session limit, the weekly limit, and any model-specific weekly limits on your plan.
- **Toolbar badge** with the current percentage, colored green, yellow (80%) or red (90%).
- **Alerts with sound** at 80% and 90%, then at every percent from 95%. The 90% alert stays on screen until you dismiss it. Sounds play even when no claude.ai tab is open.
- **Pace forecast.** From your last hour of use it estimates when you will hit 100%, and warns you if that is less than 30 minutes away and before the limit resets.
- **Reset notice.** After a warning, it tells you when that limit resets and you can continue.
- **Private.** No servers, no analytics, no account. The only requests go to claude.ai, using your existing login. Settings and history stay in your browser.

All thresholds, the sound, volume and badge are adjustable in Settings.

## Install (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `browser-extension` folder.
5. Make sure you are logged in to claude.ai, then click the Claude Meter icon in the toolbar. Pin it to keep the badge visible.

## How it works

The background worker asks claude.ai for your organization and its usage every 2 minutes, and about 30 seconds after you send a message on claude.ai. If the direct request is blocked, it makes the same request from an open claude.ai tab.

claude.ai does not document this data, so it can change without notice. If the popup shows an error, open **Settings > Diagnostics** to see what claude.ai returned, and please open an issue.

## Permissions

| Permission | Why |
| --- | --- |
| `claude.ai` access | Read your usage with your existing login |
| `storage` | Settings, the latest reading, and an hour of history for the forecast |
| `alarms` | Check usage on a schedule |
| `notifications` | Alerts |
| `offscreen` | Play alert sounds (background workers can't play audio) |
