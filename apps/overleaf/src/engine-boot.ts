// The engine page's first script (engine.html): it takes the tab's port,
// and only then loads the engine (engine.ts,
// and through it the core's worker). Anything that keeps the engine from
// starting (its modules failing to load, its worker failing to start) is
// then said to the tab as `{ event: "engine", ok: false, error }` on that
// port; before, the tab waited for an answer for ever, "Reading the
// project" on its card (issue #39). This script imports nothing, so that
// it runs whatever the rest does.

/** Whether the tab is the local mock (a scenario may ask for a failure there, `test`). */
const local = /^http:\/\/localhost(:\d+)?$/.test(location.ancestorOrigins?.[0] ?? "");

let taken = false;
addEventListener("message", (e) => {
  const port = e.ports[0];
  // (the tab's one port: its frame's parent's, the first)
  const ask = e.data as { src?: string; test?: string } | string;
  const hello = ask === "phitex-engine" || (typeof ask === "object" && ask?.src === "phitex-engine");
  if (taken || e.source !== parent || !hello || !port) return;
  taken = true;
  const test = local && typeof ask === "object" ? ask.test : undefined;
  const failed = (err: unknown) => port.postMessage({ event: "engine", ok: false, error: `the engine didn't start: ${err instanceof Error ? err.message : String(err)}` });
  if (test === "engine-module") return failed(new Error("a test: the engine's modules failed to load"));
  import("./engine.js").then((m) => m.serve(port, test)).catch(failed);
});
