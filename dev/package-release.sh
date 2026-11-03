#!/usr/bin/env bash
# Builds the files of a release in dist/release, after checking the GNOME zips with shexli:
#   claude-meter-gnome-<version>.shell-extension.zip             GNOME 45-51
#   claude-meter-gnome-<version>-gnome42-44.shell-extension.zip  GNOME 42-44
#   usage-meter-for-claude-<version>.zip                         browser: unzips to one folder for Load unpacked
#   usage-meter-for-claude-<version>-webstore.zip                browser: for the Chrome Web Store
#   SHA256SUMS
# and the release notes in dist/release-notes.md.
# Usage: dev/package-release.sh   (needs gnome-extensions, glib-compile-schemas, zip, jq and python3)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/dist/release"
UUID=$(jq -r .uuid "$REPO/gnome-extension/metadata.json")
GNOME_VERSION=$(jq -r '."version-name"' "$REPO/gnome-extension/metadata.json")
BROWSER_VERSION=$(jq -r .version "$REPO/browser-extension/manifest.json")

make -C "$REPO" -s lint
"$REPO/browser-extension/package.sh" >/dev/null

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$REPO/dist/$UUID.shell-extension.zip" "$OUT/claude-meter-gnome-$GNOME_VERSION.shell-extension.zip"
cp "$REPO/dist/$UUID.legacy.shell-extension.zip" "$OUT/claude-meter-gnome-$GNOME_VERSION-gnome42-44.shell-extension.zip"
cp "$REPO/dist/usage-meter-for-claude-$BROWSER_VERSION.zip" "$REPO/dist/usage-meter-for-claude-$BROWSER_VERSION-webstore.zip" "$OUT/"
(cd "$OUT" && sha256sum -- *.zip > SHA256SUMS)

cat > "$REPO/dist/release-notes.md" <<EOF
## Claude Meter for GNOME $GNOME_VERSION

For GNOME Shell 45 to 51: \`claude-meter-gnome-$GNOME_VERSION.shell-extension.zip\`. For GNOME 42 to 44: \`claude-meter-gnome-$GNOME_VERSION-gnome42-44.shell-extension.zip\`.

\`\`\`bash
gnome-extensions install --force claude-meter-gnome-$GNOME_VERSION.shell-extension.zip
\`\`\`

Then log out and back in, and turn on Claude Meter in the Extensions app. The zip is the extension alone: to have Claude Code's status line feed it, clone the repository and run \`./install.sh\` instead (see the README).

## Usage Meter for Claude $BROWSER_VERSION (browser extension)

For Chrome, Chromium, Brave and Edge. Unzip \`usage-meter-for-claude-$BROWSER_VERSION.zip\`, open \`chrome://extensions\`, turn on Developer mode, choose **Load unpacked** and pick the \`usage-meter-for-claude\` folder. \`usage-meter-for-claude-$BROWSER_VERSION-webstore.zip\` is the package for the Chrome Web Store.

\`SHA256SUMS\` has the checksums of all four files.
EOF

ls -1 "$OUT"
