#!/usr/bin/env bash
# The web frontend's build (web/dist/, scripts/build-web.sh) into
# PhiTeX.org's site, served at /try: its public/try/, replaced whole. The
# site's own git and deploy are the site's: this commits and pushes nothing.
#
#   scripts/deploy-web.sh [SITE]   # SITE: default ~/code/flinner/PhiTeX.org
set -euo pipefail
cd "$(dirname "$0")/.."
site="${1:-$HOME/code/flinner/PhiTeX.org}"
[ -s web/dist/dist/web.js ] || { echo "no web/dist: scripts/build-web.sh first" >&2; exit 1; }
[ -f "$site/vite.config.ts" ] || { echo "not PhiTeX.org's checkout: $site" >&2; exit 1; }
# (files written in place, the gone ones removed: a dev server running meanwhile keeps
# knowing them; removed and copied anew, vite's dev server lost track of them until restarted)
mkdir -p "$site/public/try"
rsync -a --delete --exclude=/index.html web/dist/ "$site/public/try/"   # (the site's own try.html is the page)
du -sh "$site/public/try"
