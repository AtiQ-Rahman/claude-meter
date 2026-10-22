#!/usr/bin/env bash
# Build the zip to upload to the Chrome Web Store: dist/usage-meter-for-claude-<version>.zip
set -euo pipefail
cd "$(dirname "$0")"
version=$(jq -r .version manifest.json)
out="../dist/usage-meter-for-claude-$version.zip"
mkdir -p ../dist
rm -f "$out"
zip -qr "$out" manifest.json src popup options offscreen content sounds icons
echo "Built $out"
