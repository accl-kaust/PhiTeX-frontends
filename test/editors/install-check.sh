#!/usr/bin/env bash
# The plugins' download (phitex-install, :PhiTeXInstall) against a release
# made here, signed with a key made here: a good one is installed; a bad
# signature, a tarball that doesn't match, and "no" at the prompt install
# nothing; a download that fails names its channel and its URL. With
# PHITEX_INSTALL_LIVE=1 (CI's editors job), also each plugin's own default:
# the channel it ships with (nightly until v1.0) downloaded from GitHub,
# checked against PhiTeX's release key, and run. Needs minisign, emacs and
# nvim. Exits 1 on a failure.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"; rel="$tmp/rel"; mkdir -p "$rel" "$tmp/w"
export HOME="$tmp/home" XDG_DATA_HOME="$tmp/home/data"; mkdir -p "$HOME"
minisign -G -W -p "$tmp/k.pub" -s "$tmp/k.key" >/dev/null
minisign -G -W -p "$tmp/other.pub" -s "$tmp/other.key" >/dev/null
key=$(tail -1 "$tmp/k.pub")
case "$(uname -s)" in Linux) os=linux;; *) os=macos;; esac
case "$(uname -m)" in x86_64|amd64) arch=x86_64;; *) arch=aarch64;; esac
asset="phitex-$arch-$os.tar.gz"
printf '#!/bin/sh\necho phitex fake\n' > "$tmp/w/phitex"; chmod +x "$tmp/w/phitex"
tar -czf "$rel/$asset" -C "$tmp/w" phitex
release() { (cd "$rel" && sha256sum "$asset" > SHA256SUMS && rm -f SHA256SUMS.minisig && minisign -S -s "$tmp/$1.key" -m SHA256SUMS >/dev/null); }
status=0
# (editor, answer, what to expect)
run() { # name editor answer want(installed|nothing) pattern
  local name=$1 ed=$2 ans=$3 want=$4 pat=$5 pre="$tmp/p$RANDOM" out
  case $ed in
    emacs) out=$(env -u DISPLAY emacs --batch -Q -l "$repo/editors/emacs/phitex.el" --eval "(progn (setq phitex-release-base \"file://$rel\" phitex-release-key \"$key\" phitex-install-prefix \"$pre\") (fset 'yes-or-no-p (lambda (_) $([ "$ans" = yes ] && echo t || echo nil))) (condition-case e (phitex-install) (error (princ (error-message-string e)))))" 2>&1) ;;
    nvim) out=$(nvim --clean --headless --cmd "lua PhitexInstall = { base = 'file://$rel', key = '$key', prefix = '$pre' }" -c "luafile $repo/editors/nvim/phitex.lua" -c "lua vim.fn.confirm = function() return $([ "$ans" = yes ] && echo 1 || echo 2) end; vim.notify = function(m) io.stdout:write(m .. '\n') end" -c "PhiTeXInstall" -c "qa!" 2>&1) ;;
  esac
  local got=nothing; [ -x "$pre/bin/phitex" ] && got=installed
  if [ "$got" = "$want" ] && grep -q -- "$pat" <<<"$out"; then echo "ok $ed: $name"; else echo "FAIL $ed: $name: $got; said: $out"; status=1; fi
}
for ed in emacs nvim; do
  release k
  run "a good release is installed" $ed yes installed "installed in"
  run "no at the prompt installs nothing" $ed no nothing ""
  release other
  run "another key's signature installs nothing" $ed yes nothing "signature does not verify"
  release k
  cp "$rel/$asset" "$tmp/keep"; printf x >> "$rel/$asset"
  run "a tarball changed after signing installs nothing" $ed yes nothing "does not match SHA256SUMS"
  cp "$tmp/keep" "$rel/$asset"
done
# (a release that is not there: the error names the channel and the URL)
for ed in emacs nvim; do
  rel_keep=$rel; rel="$tmp/none"
  run "a missing release says its channel and URL" $ed yes nothing "from the nightly channel (file://$tmp/none)"
  rel=$rel_keep
done
# (each plugin's own channel and key, from GitHub: what a user's first start downloads)
if [ "${PHITEX_INSTALL_LIVE:-}" = 1 ]; then
  for ed in emacs nvim; do
    pre="$tmp/live-$ed"
    case $ed in
      emacs) out=$(env -u DISPLAY emacs --batch -Q -l "$repo/editors/emacs/phitex.el" --eval "(progn (setq phitex-install-prefix \"$pre\") (fset 'yes-or-no-p (lambda (_) t)) (condition-case e (phitex-install) (error (princ (error-message-string e)))))" 2>&1) ;;
      nvim) out=$(nvim --clean --headless --cmd "lua PhitexInstall = { prefix = '$pre' }" -c "luafile $repo/editors/nvim/phitex.lua" -c "lua vim.fn.confirm = function() return 1 end; vim.notify = function(m) io.stdout:write(m .. '\\n') end" -c "PhiTeXInstall" -c "qa!" 2>&1) ;;
    esac
    v=$("$pre/bin/phitex" --version 2>&1 | head -1)
    if [ -x "$pre/bin/phitex" ] && grep -q '"channel": "nightly"' "$XDG_DATA_HOME/phitex/install.json" && [ -n "$v" ]; then echo "ok $ed: its own channel's release installed and runs: $v"; else echo "FAIL $ed: its own channel's release: said: $out; --version: $v"; status=1; fi
  done
fi
exit $status
