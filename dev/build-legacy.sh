#!/usr/bin/env bash
# Build the GNOME 42-44 extension from the GNOME 45+ source in gnome-extension/.
# GNOME 45 moved extensions to ES modules; 42-44 load them through the legacy
# `imports` object and call a global init(), and the settings window through a
# global fillPreferencesWindow(). This rewrites the import lines, swaps the
# Extension and ExtensionPreferences base classes for small stand-ins and appends
# those functions. The extension's other modules lose their `export`: the legacy
# importer exposes their top-level functions and `var`s. The settings schema is
# compiled into the copy, as GNOME 42 and 43 don't compile it on install.
# Usage: dev/build-legacy.sh [out-dir]   (default: build/legacy)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/gnome-extension"
OUT="${1:-$REPO/build/legacy}"

# Homebrew's builds earlier in PATH may write schemas the shell doesn't read.
COMPILE=$([ -x /usr/bin/glib-compile-schemas ] && echo /usr/bin/glib-compile-schemas || echo glib-compile-schemas)

class=$(sed -nE 's/^export default class (\w+) extends Extension \{$/\1/p' "$SRC/extension.js")
[ -n "$class" ] || { echo "build-legacy: no 'export default class ... extends Extension {' line in $SRC/extension.js"; exit 1; }
prefs_class=$(sed -nE 's/^export default class (\w+) extends ExtensionPreferences \{$/\1/p' "$SRC/prefs.js")
[ -n "$prefs_class" ] || { echo "build-legacy: no 'export default class ... extends ExtensionPreferences {' line in $SRC/prefs.js"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/schemas"
cp "$SRC/stylesheet.css" "$OUT/"
sed -E 's/"shell-version": \[[^]]*\]/"shell-version": ["42", "43", "44"]/' "$SRC/metadata.json" > "$OUT/metadata.json"
grep -q '"shell-version": \["42", "43", "44"\]' "$OUT/metadata.json" \
  || { echo "build-legacy: keep \"shell-version\" on one line in $SRC/metadata.json"; exit 1; }
cp "$SRC"/schemas/*.gschema.xml "$OUT/schemas/"
"$COMPILE" --strict "$OUT/schemas"

shim=$(mktemp)
prefs_shim=$(mktemp)
trap 'rm -f "$shim" "$prefs_shim"' EXIT
cat > "$shim" <<'EOF'
const ExtensionUtils = imports.misc.extensionUtils;

// Stand-in for the GNOME 45+ Extension base class.
class Extension {
    constructor(meta) {
        this.metadata = meta.metadata;
        this.uuid = meta.uuid;
        this.dir = meta.dir;
        this.path = meta.path;
    }

    getSettings(schema) {
        return ExtensionUtils.getSettings(schema);
    }

    openPreferences() {
        ExtensionUtils.openPrefs();
    }
}
EOF
cat > "$prefs_shim" <<'EOF'
const ExtensionUtils = imports.misc.extensionUtils;

// Stand-in for the GNOME 45+ ExtensionPreferences base class.
class ExtensionPreferences {
    constructor(meta) {
        this.metadata = meta.metadata;
        this.uuid = meta.uuid;
        this.dir = meta.dir;
        this.path = meta.path;
    }

    getSettings(schema) {
        return ExtensionUtils.getSettings(schema);
    }
}
EOF

gi_import="s#^import (\w+) from 'gi://(\w+)';\$#const \1 = imports.gi.\2;#"
{
  # The shim defines ExtensionUtils, so imports of the extension's own modules
  # must come after the Extension import.
  sed -E \
    -e "$gi_import" \
    -e "s#^import \* as (\w+) from 'resource:///org/gnome/shell/(ui|misc)/(\w+)\.js';\$#const \1 = imports.\2.\3;#" \
    -e "\#^import \{Extension\} from 'resource:///org/gnome/shell/extensions/extension\.js';\$#{r $shim" -e 'd}' \
    -e "s#^import \{([^}]+)\} from '\./(\w+)\.js';\$#const {\1} = ExtensionUtils.getCurrentExtension().imports.\2;#" \
    -e 's/^export default class /class /' \
    "$SRC/extension.js"
  printf '\nfunction init(meta) {\n    return new %s(meta);\n}\n' "$class"
} > "$OUT/extension.js"

{
  sed -E \
    -e "$gi_import" \
    -e "\#^import \{ExtensionPreferences\} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs\.js';\$#{r $prefs_shim" -e 'd}' \
    -e 's/^export default class /class /' \
    "$SRC/prefs.js"
  printf '\nfunction init() {\n}\n\nfunction fillPreferencesWindow(window) {\n    new %s(ExtensionUtils.getCurrentExtension()).fillPreferencesWindow(window);\n}\n' "$prefs_class"
} > "$OUT/prefs.js"

for module in "$SRC"/*.js; do
  case "$(basename "$module")" in extension.js|prefs.js) continue ;; esac
  sed -E -e "$gi_import" -e 's/^export function /function /' -e 's/^export const /var /' "$module" > "$OUT/$(basename "$module")"
done

if grep -nE '^\s*(import|export)\b' "$OUT"/*.js; then
  echo "build-legacy: no GNOME 42-44 form for the lines above; add a rule to $0"
  exit 1
fi
echo "Built GNOME 42-44 extension in $OUT"
