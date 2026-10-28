#!/usr/bin/env bash
# MuPDF's WebAssembly build (mupdf on npm, AGPL-3.0-or-later), the one
# PhiTeX's live viewer draws with: the version and the tarball's SHA-256
# read from phitex/scripts/fetch-mupdf.sh (the pin is PhiTeX's), the files
# into target/mupdf/, which the builds copy into dist/mupdf/. Not committed
# (published minified).
#
#   scripts/fetch-mupdf.sh     # target/mupdf/{mupdf.js,mupdf-wasm.js,mupdf-wasm.wasm}
set -euo pipefail
cd "$(dirname "$0")/.."

pin=phitex/scripts/fetch-mupdf.sh
version=$(sed -n 's/^version=//p' "$pin")
sha256=$(sed -n 's/^sha256=//p' "$pin")
[ -n "$version" ] && [ -n "$sha256" ] || { echo "no MuPDF pin in $pin" >&2; exit 1; }
dir=target/mupdf
tgz="target/mupdf-$version.tgz"
mkdir -p "$dir"
if [ ! -f "$tgz" ] || [ "$(sha256sum "$tgz" | cut -d' ' -f1)" != "$sha256" ]; then
  curl -fsSL --retry 3 "https://registry.npmjs.org/mupdf/-/mupdf-$version.tgz" -o "$tgz"
fi
[ "$(sha256sum "$tgz" | cut -d' ' -f1)" = "$sha256" ] || { echo "SHA-256 mismatch: $tgz" >&2; exit 1; }
for f in mupdf.js mupdf-wasm.js mupdf-wasm.wasm; do
  tar -xzOf "$tgz" "package/dist/$f" > "$dir/$f"
done
echo "mupdf $version: $dir"
