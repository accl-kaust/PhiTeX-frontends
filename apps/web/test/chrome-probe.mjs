// What this machine's Chrome allows the core (printed before the browser
// checks in CI, so a failure there says why): the shared memory the
// threaded core starts with (2 GiB, grown to 4 if it can: common/src/wasm/threads.ts),
// a 4 GiB one and a second beside it, the single-threaded core's own, and smaller ones; with the machine's
// memory, its overcommit mode, its limits and its renderers' data limit. Exits 0 always.
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
// (sandboxed, as a user's Chrome runs: the sandbox lowers each renderer's
// RLIMIT_DATA to 8 GiB on a machine with 16 GB of memory or less, 16 GiB up
// to 32 GB, 32 GiB above (Chromium's sandbox_linux.cc), and the core's 4 GiB
// counts against it; with --no-sandbox nothing is limited)
const b = await chromium.launch({ executablePath: chrome, chromiumSandbox: true, args: ["--disable-crashpad", "--disable-crash-reporter"], env: { ...process.env, HOME: home } });
const p = await b.newPage();
await p.goto("about:blank");
console.log(`renderers' data limit (bytes; count): ${sh("for p in $(pgrep -f -- '--type=renderer'); do grep 'Max data size' /proc/$p/limits | tr -s ' ' | cut -d' ' -f4; done | sort | uniq -c | tr -s ' ' | tr '\\n' ';'")}`);
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
  // (the threaded core's: made at 2 GiB, grown to 4 at its start if the browser gives it, else 3, else kept: threads.ts chooseSize)
  const c = tryMem("shared 32768 pages to 65535 (the threaded core's start)", { initial: 32768, maximum: 65535, shared: true });
  for (const [name, pages] of [["grown to 4 GiB", 32767], ["grown to 3 GiB", 16384]]) {
    if (!c || out["the core's size"]) break;
    try {
      c.grow(pages);
      out["the core's size"] = name;
    } catch (e) {
      out[name] = String(e);
    }
  }
  const a = tryMem("shared 65535 pages", { initial: 65535, maximum: 65535, shared: true });
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
