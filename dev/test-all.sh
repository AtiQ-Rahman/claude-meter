#!/usr/bin/env bash
# Run dev/smoke-test.sh on every supported GNOME Shell version, each in a throwaway
# Alpine container that ships it. GNOME 42-44 get the build from dev/build-legacy.sh.
# Packages are installed when the container starts (about 1 GB per version, every
# run), so only the small Alpine base images stay behind: no images, no build cache.
# Usage: dev/test-all.sh [version...]   (default: 42 to 51)
# Results, logs and screenshots go to .dev/matrix/<version>/.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
declare -A ALPINE=([42]=3.16 [43]=3.17 [44]=3.18 [45]=3.19 [46]=3.20 [47]=3.21 [48]=3.22 [49]=3.23 [50]=3.24 [51]=edge)
# gdm, networkmanager and polkit are only here for typelibs GNOME Shell imports at startup;
# glib compiles the settings schema; python3 runs the smoke test's fake usage API.
PACKAGES="bash dbus gdm glib gnome-shell jq mesa-dri-gallium networkmanager polkit python3 sound-theme-freedesktop"
versions=("$@")
[ ${#versions[@]} -gt 0 ] || versions=(42 43 44 45 46 47 48 49 50 51)

# A running test container takes about 1.5 GB of Docker's storage.
root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || { echo "Docker is not available"; exit 1; }
free_kb=$(df -Pk "$root" 2>/dev/null | awk 'NR == 2 {print $4}')
if [ -n "$free_kb" ] && [ "$free_kb" -lt $((4 * 1024 * 1024)) ]; then
  echo "Only $((free_kb / 1024 / 1024)) GB free for Docker in $root; test-all needs about 4 GB."
  exit 1
fi

"$REPO/dev/build-legacy.sh" >/dev/null || exit 1

failed=0
for v in "${versions[@]}"; do
  [ -n "${ALPINE[$v]:-}" ] || { echo "GNOME $v: unsupported version"; failed=1; continue; }
  out="$REPO/.dev/matrix/$v"
  rm -rf "$out"
  mkdir -p "$out" || exit 1
  printf 'GNOME %-3s ' "$v"
  ext=/src/gnome-extension
  [ "$v" -lt 45 ] && ext=/src/build/legacy
  # dbus-daemon won't start for a uid without a passwd entry, so add one matching
  # the host user, which also keeps the mounted output directory writable.
  if docker run --rm -v "$REPO:/src:ro" -v "$out:/out" "alpine:${ALPINE[$v]}" sh -c '
       apk add -q --no-cache $0 && (apk add -q --no-cache font-dejavu || apk add -q --no-cache ttf-dejavu) &&
       adduser -D -u "$1" tester && su tester -c "SMOKE_DIR=/out/smoke /src/dev/smoke-test.sh $2"' \
       "$PACKAGES" "$(id -u)" "$ext" >"$out/test.log" 2>&1; then
    echo "PASS  $(sed -n 's/^ok   GNOME Shell \([0-9.]*\),.*/\1/p' "$out/test.log")"
  else
    echo "FAIL  see $out/test.log"; failed=1
  fi
done
echo "Screenshots: $REPO/.dev/matrix/<version>/smoke/screenshot.png"
exit $failed
