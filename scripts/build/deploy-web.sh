#!/usr/bin/env bash
# The web frontend's build (build/web/, scripts/build/build-web.sh) to
# demo.phitex.org: Cloudflare Pages project phitex-demo, its whole site
# replaced by this build. wrangler authenticates with an API token (Cloudflare
# Pages: Edit) read from TOKEN_FILE (default ~/code/login/cloudflare-token,
# the user's, mode 600; never printed): a copied `wrangler login` stops
# working once either copy refreshes its token. The project once:
#   scripts/build/deploy-web.sh --create
# (demo.phitex.org is the project's custom domain, set in Cloudflare's dashboard once.)
#
#   scripts/build/deploy-web.sh [--create]
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -s build/web/dist/web.js ] && [ -s build/web/_headers ] || { echo "no build/web: scripts/build/build-web.sh first" >&2; exit 1; }
# (Pages takes 25 MiB a file and 20000 files)
big=$(find build/web -type f -size +25M)
[ -z "$big" ] || { echo "over Pages' 25 MiB a file: $big" >&2; exit 1; }
dist="$PWD/build/web"
token="${TOKEN_FILE:-$HOME/code/login/cloudflare-token}"
[ -s "$token" ] || { echo "no API token in $token (Cloudflare Pages: Edit)" >&2; exit 1; }
home="${WRANGLER_HOME:-$HOME/code/tmp/phitex-demo-wrangler}"
mkdir -p "$home"
cd "$home"
wr() { /home/lambda/.local/bin/bw --net env HOME="$home" XDG_CONFIG_HOME="$home/.config" CLOUDFLARE_ACCOUNT_ID=2925ae0c4cb07a33b3ab848a3a4c6c99 CLOUDFLARE_API_TOKEN="$(cat "$token")" npx --yes wrangler@4 "$@"; }
[ "${1:-}" = --create ] && wr pages project create phitex-demo --production-branch main --force
wr pages deploy "$dist" --project-name phitex-demo --branch main --commit-dirty=true
