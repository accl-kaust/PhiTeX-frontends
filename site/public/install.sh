#!/bin/sh
# PhiTeX's installer.
#
#   curl -fsSL https://phitex.org/install.sh | sh
#
# Downloads the phitex binary for this machine from PhiTeX's GitHub
# release, checks it against the release's SHA256SUMS (and that file's
# minisign signature when minisign is installed), and puts it in
# ~/.local/bin. Nothing else on the machine is touched, and nothing is
# sent but the downloads themselves.
#
# Settings (environment):
#   PHITEX_VERSION=1.6     a version instead of the latest release
#   PHITEX_CHANNEL=nightly the nightly (dev's, rebuilt each night) instead;
#                          `phitex upgrade` then follows the nightly
#   PHITEX_PREFIX=DIR      install into DIR/bin (default ~/.local)
#
# `phitex upgrade` updates an install made by this script.
set -eu

REPO=accl-kaust/PhiTeX
PREFIX=${PHITEX_PREFIX:-$HOME/.local}
VERSION=${PHITEX_VERSION:-}
CHANNEL=${PHITEX_CHANNEL:-stable}
# The releases' signing key (minisign; PhiTeX's ci/minisign.pub). With
# minisign installed, SHA256SUMS's signature is checked against it.
PUBKEY="RWS/tPWBRVVf0Y9h/ODPiO2EgZi1labeCog3siaCfIdaC9HJkDJZ8k4u"
# The nightly's own key (PhiTeX's ci/nightly.pub): a nightly is never
# checked against the releases' key.
NIGHTLY_PUBKEY="RWT5jA+G82gT+bMpGqolUeaWPm6OYkLC4m6lI8G5HbUnyL3yY5UpGCYD"

say() { printf 'phitex: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "no build for $(uname -s): build from source (https://github.com/$REPO)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) die "no build for $(uname -m): build from source (https://github.com/$REPO)" ;;
esac
asset="phitex-$arch-$os.tar.gz"

case $CHANNEL in
  stable) ;;
  nightly) [ -z "$VERSION" ] || die "PHITEX_VERSION and PHITEX_CHANNEL=nightly: one or the other" ;;
  *) die "PHITEX_CHANNEL is stable or nightly, not $CHANNEL" ;;
esac
if [ "$CHANNEL" = nightly ]; then
  base="https://github.com/$REPO/releases/download/nightly"
  PUBKEY=$NIGHTLY_PUBKEY
elif [ -n "$VERSION" ]; then
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

if command -v curl > /dev/null 2>&1; then
  get() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
elif command -v wget > /dev/null 2>&1; then
  get() { wget -q --https-only -O "$2" "$1"; }
else
  die "needs curl or wget"
fi
if command -v sha256sum > /dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum > /dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "needs sha256sum or shasum"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading ${VERSION:+v${VERSION#v} }$asset"
get "$base/SHA256SUMS" "$tmp/SHA256SUMS" \
  || die "no release found at $base (is there a release yet? https://github.com/$REPO/releases)"
get "$base/$asset" "$tmp/$asset" || die "the release has no $asset"

if [ -n "$PUBKEY" ]; then
  if command -v minisign > /dev/null 2>&1; then
    get "$base/SHA256SUMS.minisig" "$tmp/SHA256SUMS.minisig" || die "the release has no signature"
    minisign -Vqm "$tmp/SHA256SUMS" -P "$PUBKEY" || die "SHA256SUMS's signature does not verify: nothing installed"
    say "signature verified"
  else
    say "minisign not installed: checked by SHA-256 over HTTPS only"
  fi
fi

want=$(awk -v f="$asset" '$2 == f || $2 == "*" f {print $1}' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS does not list $asset"
[ "$(sha "$tmp/$asset")" = "$want" ] || die "$asset does not match SHA256SUMS: nothing installed"

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/phitex" ] || die "$asset has no phitex binary"
mkdir -p "$PREFIX/bin"
# (beside it, then renamed: a running phitex keeps its file)
cp "$tmp/phitex" "$PREFIX/bin/.phitex.new"
chmod 755 "$PREFIX/bin/.phitex.new"
mv -f "$PREFIX/bin/.phitex.new" "$PREFIX/bin/phitex"

installed=$("$PREFIX/bin/phitex" --version 2>/dev/null | head -1 || true)
data=${XDG_DATA_HOME:-$HOME/.local/share}/phitex
mkdir -p "$data"
printf '{"method": "script", "prefix": "%s", "asset": "%s", "channel": "%s"}\n' "$PREFIX" "$asset" "$CHANNEL" > "$data/install.json"

say "installed ${installed:-phitex} in $PREFIX/bin"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) say "add $PREFIX/bin to your PATH, for example: echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.profile" ;;
esac
