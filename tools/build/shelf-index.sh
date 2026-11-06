#!/usr/bin/env bash
# Take Shelf's current release (schema 1: every file by its texmf path,
# every pack in the pack table) into the extension, as the index it ships
# (the fallback; newer releases are fetched by the extension itself,
# src/release.ts): its index as shelf-index.tsv.gz, its pack table (each
# pack's SHA-256 and size, every pack checked against it) as
# shelf-packs.tsv.gz, and its release.json (the engines' search paths and
# deps columns, which the index is read by: src/resolve.ts) as
# shelf-release.json. Downloaded from Shelf (needs the network; SHELF_URL,
# default Shelf v1: its Cloudflare Pages address where phitex.org is not
# reachable, https://shelf-phitex-v1.pages.dev/tl2026/, serves the same).
#   tools/build/shelf-index.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
url="${SHELF_URL:-https://v1.shelf.phitex.org/tl2026/}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsS -o "$tmp/release.json" "${url}release.json"
read -r schema index table < <(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["schema"], r["index"], r.get("pack_table") or "-")' "$tmp/release.json")
[ "$schema" = 1 ] || { echo "${url}release.json: schema $schema, this extension reads 1" >&2; exit 1; }
[ "$table" != - ] || { echo "${url}release.json: no pack table, refused" >&2; exit 1; }
curl -fsS -o "$tmp/index.tsv.gz" "$url$index"
curl -fsS -o "$tmp/packs.tsv.gz" "$url$table"
gzip -t "$tmp/index.tsv.gz" "$tmp/packs.tsv.gz"
mv "$tmp/index.tsv.gz" shelf/shelf-index.tsv.gz
mv "$tmp/packs.tsv.gz" shelf/shelf-packs.tsv.gz
mv "$tmp/release.json" shelf/shelf-release.json
echo "shelf-index.tsv.gz: $(gzip -dc shelf/shelf-index.tsv.gz | wc -l) paths, shelf-packs.tsv.gz: $(gzip -dc shelf/shelf-packs.tsv.gz | wc -l) packs, release $(basename "$index" .tsv.gz | sed 's/^index-//')"
