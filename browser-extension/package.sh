#!/usr/bin/env bash
# Build the extension zips in dist/:
#   usage-meter-for-claude-<version>.zip           GitHub release: unzips to one folder for "Load unpacked"
#   usage-meter-for-claude-<version>-webstore.zip  Chrome Web Store: manifest.json at the zip root
set -euo pipefail
cd "$(dirname "$0")"
FILES=(manifest.json src popup options offscreen content sounds icons)
version=$(jq -r .version manifest.json)
dist=$(realpath ../dist 2>/dev/null || true)
mkdir -p ../dist && dist=$(realpath ../dist)
release="$dist/usage-meter-for-claude-$version.zip"
store="$dist/usage-meter-for-claude-$version-webstore.zip"
rm -f "$release" "$store"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/usage-meter-for-claude"
cp -r "${FILES[@]}" "$stage/usage-meter-for-claude/"
(cd "$stage" && zip -qr "$release" usage-meter-for-claude)
zip -qr "$store" "${FILES[@]}"

echo "Built $release"
echo "Built $store"
