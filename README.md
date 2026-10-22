# Claude Meter

Live Claude usage in your GNOME top bar, like a system monitor for your Claude limits.

![Claude Meter in the GNOME top bar with its menu open](screenshot.png)

```
✳ S 38%  W 35%
```

- **S**: session usage (the rolling 5-hour limit)
- **W**: weekly usage (the 7-day limit)
- Colors: green below 60%, yellow from 60%, red from 85%

Click the indicator for progress bars, time until each limit resets, and when the data was last updated.

> Unofficial community project. Not affiliated with or endorsed by Anthropic.

## How it works

Claude Code passes usage data, including your rate limits, to its [status line](https://docs.claude.com/en/docs/claude-code/statusline) command. `statusline.sh` saves that data to `~/.cache/claude-meter/usage.json`, and the GNOME extension reads the file every 10 seconds.

No API calls, no credentials, and no network access. Everything stays on your machine.

Because of this, the meter updates while you use Claude Code. Usage from claude.ai in the browser shows up the next time Claude Code reports. If the data is older than 15 minutes, the numbers turn grey.

## Requirements

- Claude Code with a Claude subscription (Pro or Max). Rate limit data is only sent for subscription accounts.
- GNOME Shell 42 (tested on Ubuntu 22.04, X11)
- `jq`

## Install

```bash
git clone https://github.com/AtiQ-Rahman/claude-meter.git
cd claude-meter
./install.sh
```

Then restart GNOME Shell (X11: `Alt+F2`, type `r`, `Enter`. Wayland: log out and back in) and send any message in Claude Code.

The installer:

1. Sets `statusLine` in `~/.claude/settings.json` to this repo's `statusline.sh` (your old file is saved as `settings.json.bak`)
2. Links `gnome-extension/` into `~/.local/share/gnome-shell/extensions/` and enables it

Keep the cloned folder where it is. The status line and the extension both point to it.

## Settings

Open the indicator and go to **Settings**:

- **Show Session (S)** / **Show Week (W)**: show or hide each value in the top bar
- **Position in top bar**: Left, Center or Right

![Toggling Session and Week on and off from the Settings menu](demo.gif)

Settings are saved in `~/.config/claude-meter/settings.json`.

## Terminal status line

Because usage now lives in the top bar, the Claude Code status line only shows the model and context usage:

```
Opus 5.5 · ctx 6%
```

`ctx` is how full the current conversation's context window is. To show session and weekly usage in the terminal as well, set `CLAUDE_USAGE_FULL_LINE=1` in the status line command:

```json
"statusLine": { "type": "command", "command": "CLAUDE_USAGE_FULL_LINE=1 /path/to/claude-meter/statusline.sh" }
```

## Uninstall

```bash
./install.sh --uninstall
```

## License

[MIT](LICENSE)
