#!/usr/bin/env bash
# Checks the extension zips with shexli, the static analyzer extensions.gnome.org's review
# guidelines recommend. Fails on any finding, except one known false positive below.
# Usage: dev/lint.sh zip...   (`make lint` builds the zips first)
#
# shexli runs from its own virtualenv in .dev/shexli, with versions pinned:
# - tree-sitter 0.26.0 makes shexli crash with a segmentation fault; 0.25.2 works.
# - shexli needs the zip that gets uploaded, not the repository: on a folder bigger than
#   50 MB it stops with "Package exceeds total file size limit", and a relative folder
#   path crashes it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$REPO/.dev/shexli"
REQUIREMENTS="shexli==0.2.1 tree-sitter==0.25.2 tree-sitter-javascript==0.25.0"
# shexli 0.2.1 (April 2026) calls every GNOME Shell version above 50 an "implausible future
# release". Versions up to this one are released, and dev/test-all.sh tests them.
NEWEST_RELEASED=51

[ $# -gt 0 ] || { echo "Usage: dev/lint.sh zip..."; exit 2; }

if [ "$(cat "$VENV/requirements" 2>/dev/null)" != "$REQUIREMENTS" ]; then
  rm -rf "$VENV"
  python3 -m venv "$VENV"
  # shellcheck disable=SC2086
  "$VENV/bin/pip" install --quiet --disable-pip-version-check $REQUIREMENTS
  echo "$REQUIREMENTS" > "$VENV/requirements"
fi

# Prints the shell-version list of zip $1, one version per line.
shell_versions() {
  python3 -I -c 'import json, sys, zipfile
print("\n".join(map(str, json.loads(zipfile.ZipFile(sys.argv[1]).read("metadata.json"))["shell-version"])))' "$1"
}

failed=0
for zip in "$@"; do
  zip=$(realpath "$zip")
  name=$(basename "$zip")
  result=$("$VENV/bin/shexli" --format json "$zip") || { echo "FAIL $name: shexli did not run"; failed=1; continue; }
  allowed=false
  if shell_versions "$zip" | awk -v newest="$NEWEST_RELEASED" '!/^[0-9]+$/ || $1 > newest {bad = 1} END {exit bad}'; then
    allowed=true
  fi
  findings=$(jq -r --argjson allowed "$allowed" \
    '.findings[] | select(.rule_id != "EGO-M-004" or ($allowed | not)) | "\(.rule_id) \(.severity)"' <<<"$result")
  if [ -n "$findings" ]; then
    echo "FAIL $name:"
    "$VENV/bin/shexli" "$zip" | sed 's/^/  /'
    failed=1
  elif jq -e '.findings | length > 0' <<<"$result" >/dev/null; then
    echo "ok   $name (shell-version up to $NEWEST_RELEASED, which shexli 0.2.1 thinks unreleased)"
  else
    echo "ok   $name"
  fi
done
exit "$failed"
