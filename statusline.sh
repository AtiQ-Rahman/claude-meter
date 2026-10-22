#!/usr/bin/env bash
# Claude Code status line: live session (5h) + weekly (7d) usage vitals.
# Claude Code pipes a JSON blob on stdin; we render one line.

input=$(cat)
[ -n "$CLAUDE_USAGE_DEBUG" ] && printf '%s' "$input" > "$(dirname "$0")/.last-input.json"

RESET=$'\e[0m'; DIM=$'\e[2m'; BOLD=$'\e[1m'
GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; CYAN=$'\e[36m'

color_for() { # pct -> color
  local p=${1%.*}
  if   (( p >= 85 )); then printf '%s' "$RED"
  elif (( p >= 60 )); then printf '%s' "$YELLOW"
  else printf '%s' "$GREEN"; fi
}

bar() { # pct width
  local p=${1%.*} w=${2:-10} i out=""
  (( p > 100 )) && p=100
  local filled=$(( (p * w + 50) / 100 ))
  for ((i = 0; i < w; i++)); do
    if (( i < filled )); then out+="█"; else out+="░"; fi
  done
  printf '%s' "$out"
}

until_reset() { # epoch seconds -> "2h13m" / "3d4h"
  local t=$1 now; now=$(date +%s)
  [ -z "$t" ] || [ "$t" = "null" ] && return
  local s=$(( ${t%.*} - now )); (( s < 0 )) && s=0
  local d=$(( s / 86400 )) h=$(( s % 86400 / 3600 )) m=$(( s % 3600 / 60 ))
  if   (( d > 0 )); then printf '%dd%dh' "$d" "$h"
  elif (( h > 0 )); then printf '%dh%02dm' "$h" "$m"
  else printf '%dm' "$m"; fi
}

vital() { # label pct resets_at
  local label=$1 pct=$2 reset=$3
  if [ -z "$pct" ] || [ "$pct" = "null" ]; then
    printf '%s%s --%s' "$DIM" "$label" "$RESET"; return
  fi
  local c; c=$(color_for "$pct")
  local r; r=$(until_reset "$reset")
  printf '%s %s%s %s%3.0f%%%s' "$label" "$c" "$(bar "$pct" 10)" "$BOLD" "$pct" "$RESET"
  [ -n "$r" ] && printf ' %s⟳%s%s' "$DIM" "$r" "$RESET"
}

IFS=$'\t' read -r model s_pct s_reset w_pct w_reset ctx_pct < <(
  jq -r '[
    (.model.display_name // "Claude"),
    (.rate_limits.five_hour.used_percentage // "null"),
    (.rate_limits.five_hour.resets_at // "null"),
    (.rate_limits.seven_day.used_percentage // "null"),
    (.rate_limits.seven_day.resets_at // "null"),
    (.context_window.used_percentage // "null")
  ] | map(tostring) | @tsv' <<<"$input"
)

# Cache for the GNOME top-bar extension.
if [ "$s_pct" != "null" ] || [ "$w_pct" != "null" ]; then
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-meter"
  mkdir -p "$cache_dir"
  jq -c --argjson now "$(date +%s)" \
    '{five_hour: .rate_limits.five_hour, seven_day: .rate_limits.seven_day, model: .model.display_name, updated_at: $now}' \
    <<<"$input" > "$cache_dir/usage.json.tmp" && mv "$cache_dir/usage.json.tmp" "$cache_dir/usage.json"
fi

# Usage lives in the top bar now; keep the terminal line short.
[ -z "$CLAUDE_USAGE_FULL_LINE" ] && { printf '%s%s%s' "$CYAN" "$model" "$RESET"; [ "$ctx_pct" != "null" ] && printf ' %s·%s ctx %s%.0f%%%s' "$DIM" "$RESET" "$(color_for "$ctx_pct")" "$ctx_pct" "$RESET"; echo; exit 0; }

SEP=" ${DIM}│${RESET} "
line="${CYAN}${model}${RESET}${SEP}$(vital Session "$s_pct" "$s_reset")${SEP}$(vital Week "$w_pct" "$w_reset")"
if [ "$ctx_pct" != "null" ] && [ -n "$ctx_pct" ]; then
  line+="${SEP}${DIM}ctx${RESET} $(color_for "$ctx_pct")$(printf '%.0f' "$ctx_pct")%${RESET}"
fi
printf '%s\n' "$line"
