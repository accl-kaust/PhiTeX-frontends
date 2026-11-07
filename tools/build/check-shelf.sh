#!/usr/bin/env bash
# The Shelf release the extension ships (shelf/shelf-release.json) must be
# Shelf's current one: an older index makes every first open fall behind what
# Shelf serves (2026-11-07: tl2026.8 shipped, tl2026.9 live, and Firefox made
# the format again in the browser, 79 packages). Stops the build, saying how
# to take the current one (tools/build/shelf-index.sh). Needs the network.
#   tools/build/check-shelf.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
url="${SHELF_URL:-https://v1.shelf.phitex.org/tl2026/}"
live=$(curl -fsS "${url}release.json" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["release"])')
shipped=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["release"])' shelf/shelf-release.json)
if [ "$live" != "$shipped" ]; then
  echo "check-shelf: the extension ships Shelf $shipped, Shelf's current release is $live: run tools/build/shelf-index.sh (and commit shelf/)" >&2
  exit 1
fi
echo "check-shelf: Shelf $shipped, the current release"
