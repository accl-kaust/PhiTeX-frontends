#!/usr/bin/env bash
# The web frontend's build (web/dist/, scripts/build-web.sh) to
# demo.phitex.org: Cloudflare Pages project phitex-demo, its whole site
# replaced by this build. wrangler's login is kept in .home/ (git-ignored),
# made once, and the project too:
#   bw --net env HOME=$PWD/.home npx --yes wrangler@4 login
#   bw --net env HOME=$PWD/.home npx --yes wrangler@4 pages project create phitex-demo --production-branch main
# (demo.phitex.org is the project's custom domain, set in Cloudflare's dashboard once.)
#
#   scripts/deploy-web.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -s web/dist/dist/web.js ] && [ -s web/dist/_headers ] || { echo "no web/dist: scripts/build-web.sh first" >&2; exit 1; }
# (Pages takes 25 MiB a file and 20000 files)
big=$(find web/dist -type f -size +25M)
[ -z "$big" ] || { echo "over Pages' 25 MiB a file: $big" >&2; exit 1; }
mkdir -p .home
/home/lambda/.local/bin/bw --net env HOME="$PWD/.home" npx --yes wrangler@4 pages deploy web/dist --project-name phitex-demo --branch main --commit-dirty=true
