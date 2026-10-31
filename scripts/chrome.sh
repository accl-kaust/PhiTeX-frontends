#!/usr/bin/env bash
# (Re)start the dev Chromium: its own profile (a login there persists), the
# extension loaded unpacked, DevTools protocol on :9222.  scripts/chrome.sh [url]
# (PHITEX_CDP_PORT and PHITEX_PROFILE: a second instance, e.g. :9223 with
# .chrome-profile-2, so two sessions don't close each other's tabs; the
# scripts read PHITEX_CDP_PORT too)
cd "$(dirname "$0")/.."
# (the extension as built: scripts/build.sh --dev; a build under way has it
# only once its engine and formats are made)
for f in overleaf/manifest.json overleaf/dist/background.js overleaf/dist/core.wasm overleaf/dist/folders.js; do
  [ -s "$f" ] || { echo "no $f: run scripts/build.sh --dev first (or wait for the one running)" >&2; exit 1; }
done
port="${PHITEX_CDP_PORT:-9222}"
profile="$PWD/${PHITEX_PROFILE:-.chrome-profile}"
pkill -f -- "--user-data-dir=$profile( |$)" && sleep 2
# (PHITEX_HEADLESS=1: no window, as in scripts/sandbox, which has no display;
# its size PHITEX_WINDOW, 1600,1000 by default, for screenshots)
headless=(); [ -n "${PHITEX_HEADLESS:-}" ] && headless=(--headless=new "--window-size=${PHITEX_WINDOW:-1600,1000}")
# (its caches in RAM, /dev/shm: on a spinning disk shared with builds the
# cache's writes stalled the browser; the profile itself, its logins, stays)
cache="/dev/shm/phitex-chrome-cache-$port"
nohup chromium "${headless[@]}" --user-data-dir="$profile" --disk-cache-dir="$cache" --remote-debugging-port="$port" --no-first-run \
  --enable-unsafe-extension-debugging about:blank > /dev/null 2>&1 &
# (the extension loaded over the protocol: Chromium 153 ignores --load-extension; then the page)
node scripts/load-ext.mjs "$port" > /dev/null
node -e 'fetch(`http://localhost:${process.argv[1]}/json/new?${encodeURIComponent(process.argv[2])}`, { method: "PUT" }).then((r) => r.ok || process.exit(1))' "$port" "${1:-http://localhost:8123/project/mock}"
