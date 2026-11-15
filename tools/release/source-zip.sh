#!/usr/bin/env bash
# The Firefox reviewers' source: this repository at HEAD with PhiTeX at its
# pinned commit in phitex/, symlinks resolved, and BUILD.md (BUILD.md.in, filled).
#
#   tools/release/source-zip.sh   # → build/phitex-instant-<version>-source.zip
#
# (from git, not the working tree: only committed files go in; of the
# checkout it is run in, which the release workflow makes the tag's)
set -euo pipefail
template="$(cd "$(dirname "$0")" && pwd)/BUILD.md.in"
cd "$(git rev-parse --show-toplevel)"

version=$(node -p 'require("./apps/overleaf/manifest.base.json").version')
frontends=$(git rev-parse HEAD)
phitex=$(git rev-parse HEAD:phitex)
pyodide=$(node -p 'require("./package.json").dependencies?.pyodide ?? require("./package.json").devDependencies.pyodide')
name="phitex-instant-$version-source"
out="$PWD/build/$name.zip"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/$name"
git archive "$frontends" | tar -x -C "$tmp/$name"
rm -rf "$tmp/$name/phitex" && mkdir "$tmp/$name/phitex"
git -C phitex archive "$phitex" | tar -x -C "$tmp/$name/phitex"
sed -e "s/@VERSION@/$version/g" -e "s/@FRONTENDS@/${frontends:0:12}/g" -e "s/@PHITEX@/${phitex:0:12}/g" -e "s/@PYODIDE@/$pyodide/g" \
  "$template" > "$tmp/$name/BUILD.md"
if grep -q '@[A-Z]*@' "$tmp/$name/BUILD.md"; then echo "BUILD.md: a placeholder left unfilled" >&2; exit 1; fi

mkdir -p build
rm -f "$out"
# (zip follows symlinks: common/src/viewer and apps/overleaf/src/common are copies in the archive)
(cd "$tmp" && zip -qr "$out" "$name")
echo "$out: $(unzip -l "$out" | tail -1 | awk '{print $2}') files"
