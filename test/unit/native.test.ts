import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasLsp, nativeProblem, probeNative, versionOf, whichCommand } from "../../apps/vscode/src/native.ts";

test("which phitex a name runs: the PATH's first, as the system finds it; a path as it is", () => {
  const files = new Set(["/opt/old/phitex", "/home/u/.local/bin/phitex"]);
  const exists = (p: string) => files.has(p);
  assert.equal(whichCommand("phitex", { PATH: "/usr/bin:/opt/old:/home/u/.local/bin" }, "/", exists, false), "/opt/old/phitex");
  assert.equal(whichCommand("phitex", { PATH: "/usr/bin" }, "/", exists, false), null);
  assert.equal(whichCommand("/home/u/.local/bin/phitex", {}, "/", exists, false), "/home/u/.local/bin/phitex");
  assert.equal(whichCommand("bin/phitex", {}, "/home/u/.local", exists, false), "/home/u/.local/bin/phitex");
  assert.equal(whichCommand("", { PATH: "/opt/old" }, "/", exists, false), null);
});

test("its version and whether it runs the preview", () => {
  assert.equal(versionOf("phitex 1.0.5-nightly.202611260515\nCopyright …"), "1.0.5-nightly.202611260515");
  assert.equal(hasLsp("Usage: phitex watch [OPTIONS] [FILE|DIR]\n      --lsp  Serve an editor"), true);
  assert.equal(hasLsp("error: unknown command"), false);
});

// (a stub phitex, as the testers' old one: --version answers, watch has no --lsp)
const stub = (body: string) => {
  const d = mkdtempSync(join(tmpdir(), "phitex-stub-"));
  const f = join(d, "phitex");
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};

test("a missing phitex: said in words, where it was looked for", async () => {
  const n = await probeNative("/nowhere/phitex");
  assert.equal(n.ok, false);
  assert.match(nativeProblem(n as never), /no phitex at \/nowhere\/phitex \(the setting phitex\.path\)/);
  const m = await probeNative("phitex-surely-not-installed");
  assert.match(nativeProblem(m as never), /no "phitex-surely-not-installed" command on the PATH/);
});

test("an old phitex (no watch --lsp): its version and path, too old", async () => {
  const f = stub(`case "$1" in --version) echo "phitex 0.9.0";; watch) echo "error: unexpected argument '--lsp' found" >&2; exit 2;; esac`);
  const n = await probeNative(f);
  assert.deepEqual(n.ok ? null : [n.why, (n as { version: string }).version], ["old", "0.9.0"]);
  assert.match(nativeProblem(n as never), new RegExp(`phitex 0\\.9\\.0 at ${f.replace(/[.]/g, "\\.")} is too old`));
});

test("a phitex that runs the preview", async () => {
  const f = stub(`case "$1" in --version) echo "phitex 1.0.5";; watch) echo "      --lsp   Serve an editor";; esac`);
  assert.deepEqual(await probeNative(f), { ok: true, path: f, version: "1.0.5" });
});
