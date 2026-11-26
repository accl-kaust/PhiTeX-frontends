import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../apps/vscode/package.json", import.meta.url), "utf8"));
const src = readFileSync(new URL("../../apps/vscode/src/extension.ts", import.meta.url), "utf8");
const titles = Object.fromEntries(pkg.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]));

test("every command ID of earlier releases still contributed and registered (keybindings survive)", () => {
  for (const id of ["phitex.preview", "phitex.stop", "phitex.restart", "phitex.switchEngine", "phitex.savePdf", "phitex.showLog", "phitex.menu", "phitex.rebuild", "phitex.caches", "phitex.clearCache"]) {
    assert.ok(titles[id], `${id} contributed`);
    assert.ok(src.includes(`registerCommand("${id}"`), `${id} registered`);
  }
});

test("one vocabulary, the viewer's", () => {
  assert.equal(titles["phitex.rebuild"], "Clean rebuild");
  assert.equal(titles["phitex.savePdf"], "Download PDF");
  assert.equal(titles["phitex.showLog"], "View log");
  assert.equal(titles["phitex.clearCache"], "Clear cache…");
  assert.equal(titles["phitex.menu"], "Show actions");
  // (Clear cache… once in the palette: its old name, phitex.caches, hidden there)
  assert.deepEqual(pkg.contributes.menus.commandPalette, [{ command: "phitex.caches", when: "false" }]);
});

test("Restricted Mode: limited, the native engine's settings restricted", () => {
  const u = pkg.capabilities.untrustedWorkspaces;
  assert.equal(u.supported, "limited");
  assert.deepEqual(u.restrictedConfigurations, ["phitex.path", "phitex.engine"]);
  // (the native command starts in one place, which checks the trust first)
  assert.match(src, /async function startWatch\([^)]*\): Promise<void> \{\n[^\n]*\n\s*if \(!vscode\.workspace\.isTrusted\) return restricted\(\);/);
});

test("every phitex.* setting is in the README's table", () => {
  const readme = readFileSync(new URL("../../apps/vscode/README.md", import.meta.url), "utf8");
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(readme.includes(`| \`${k}\``), `${k} in the README`);
});
