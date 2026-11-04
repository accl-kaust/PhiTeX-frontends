// What this machine's Chrome allows the core (printed before the browser
// checks in CI, so a failure there says why): the shared 4 GiB memory the
// threaded core asks for (common/src/wasm/threads.ts), a second one beside
// it, the single-threaded core's own, and smaller ones; with the machine's
// memory, its overcommit mode and its limits. Exits 0 always.
//   node web/test/chrome-probe.mjs      (PHITEX_CHROME: the browser)
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";

const sh = (c) => { try { return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "(none)"; } };
const chrome = process.env.PHITEX_CHROME ?? "/usr/bin/chromium";
console.log(`chrome: ${sh(`"${chrome}" --version`)}`);
console.log(`memory:\n${sh("free -m")}`);
console.log(`overcommit_memory: ${sh("cat /proc/sys/vm/overcommit_memory")}, overcommit_ratio: ${sh("cat /proc/sys/vm/overcommit_ratio")}`);
console.log(`CommitLimit/Committed_AS: ${sh("grep -E 'CommitLimit|Committed_AS' /proc/meminfo | tr -s ' ' | tr '\\n' ' '")}`);
console.log(`ulimit -v: ${sh("ulimit -v")}, ulimit -a:\n${sh("ulimit -a")}`);
const home = fs.mkdtempSync("/tmp/phitex-probe-");
const b = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: home } });
const p = await b.newPage();
await p.goto("about:blank");
const probe = await p.evaluate(() => {
  const out = {};
  const tryMem = (name, o) => {
    try {
      const m = new WebAssembly.Memory(o);
      out[name] = `ok (${m.buffer.byteLength >>> 20} MiB)`;
      return m;
    } catch (e) {
      out[name] = String(e);
      return null;
    }
  };
  out.crossOriginIsolated = globalThis.crossOriginIsolated;
  out.cores = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory;
  const a = tryMem("shared 65535 pages (the threaded core's)", { initial: 65535, maximum: 65535, shared: true });
  tryMem("a second shared 65535", { initial: 65535, maximum: 65535, shared: true });
  tryMem("shared 32768", { initial: 32768, maximum: 32768, shared: true });
  tryMem("shared 16384", { initial: 16384, maximum: 16384, shared: true });
  tryMem("own 65535 (the single-threaded core's)", { initial: 65535, maximum: 65535 });
  tryMem("own 1 grown to 65535", { initial: 1, maximum: 65535 });
  if (a) {
    // (touched: the pages the system commits as they are written)
    try {
      const u = new Uint8Array(a.buffer);
      for (let i = 0; i < u.length; i += 1 << 20) u[i] = 1;
      out.touched = "ok, every MiB";
    } catch (e) {
      out.touched = String(e);
    }
  }
  return out;
});
for (const [k, v] of Object.entries(probe)) console.log(`${k}: ${v}`);
await b.close();
