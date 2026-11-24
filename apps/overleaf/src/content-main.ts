// Overleaf's wiring of a PreviewSession: the page hook (hook.ts, in the
// page's world) for the editor, the project ZIP for the files, a
// MessagePort to this tab's core (a worker in the engine's iframe, engine.ts
// and worker1.ts: the core's viewer protocol, CoreSession),
// and the panel. The session is in its remote mode, as on `phitex watch`:
// the core's events say when the pages are in (settled) and what the build
// found (diagnostics); this script opens the project itself (its files,
// then setMain), and the editor's edits go to the core as requests.

import "./platform.ts";
import { platform } from "./common/platform.ts";
import type { Edit } from "./common/viewer/edits.ts";
import { older } from "./common/version.ts";
import { PreviewSession, guessMain, type CoreReq, type CoreRes, type CoreTransport, type CoreEvent, type EditorHost } from "./common/viewer/session.ts";
import { charOffset } from "./common/viewer/edits.ts";
import { readZip } from "./common/zip.ts";
import { changesButton } from "./diffui.ts";
import { overleafHistory } from "./blame.ts";
import { ProjectHistory } from "./olhistory.ts";
import type { ChangesRunner } from "./common/viewer/changes.ts";
import { AGREE, TERMS, asIs } from "./terms.ts";
import { callout, calloutStyle, type Callout } from "./callout.ts";
import { h, html, rich } from "./dom.ts";
import { filesAt, type Fetched, type PageFetch, type Version } from "./history.ts";
import { Compare, gate } from "./common/viewer/compare.ts";
import { SUPPORT, unseen, type News } from "./news.ts";
import { Panel, type PanelPrefs, type Prefs, type SettingRow, type SettingsGroup, type ViewPrefs, type ViewState } from "./common/viewer/panel.ts";
import { resetAll, usable } from "./settings.ts";
import { answer, channel, follow, mirrorOut, remoteCore, tee, type Ask } from "./mirror.ts";
import { ENGINES, approximable, resolve, shimTexts, type Engine, type EngineChoice } from "./common/viewer/engines.ts";
import { Calm } from "./common/viewer/sheetline.ts";
import { StripPages } from "./common/strippages.ts";
import { reportRow } from "./report.ts";
import { machineLine } from "./common/viewer/machine.ts";

/** The panel's preferences, in the extension's own storage (not the page's). */
const prefs: Prefs = {
  load: async () => ((await chrome.storage.local.get("panel")).panel as Partial<PanelPrefs>) ?? {},
  save: (p) => void chrome.storage.local.set({ panel: p }),
};

const project = () => location.pathname.replace(/\/$/, "").replace(/\/detache[dr]$/, "");
/** Overleaf's "Open PDF in separate tab": this tab mirrors the editor's (mirror.ts). */
/**
 * fetch as the page (its cookies, its origin): Firefox's content scripts
 * have `content.fetch` for that, their plain fetch being the extension's
 * (no Overleaf session cookie, a cross-origin request); Chrome's fetch is
 * the page's already.
 */
const rawPageFetch: typeof fetch = (globalThis as unknown as { content?: { fetch?: typeof fetch } }).content?.fetch?.bind((globalThis as unknown as { content: object }).content) ?? fetch;
/**
 * A page's promise made this script's: settled by a Promise of this
 * script's, so no callback of this script's runs on the page's promise and
 * nothing of this script's is handed to it (a page promise resolved with
 * this script's object reads its `then` across the compartments).
 */
const adopt = <T,>(p: PromiseLike<T>): Promise<T> => new Promise<T>((res, rej) => void p.then(res, rej));
/**
 * A page's response made this script's own. Firefox's `content.fetch` gives
 * the page's Response, its promises and ArrayBuffer the page's objects
 * behind Xray wrappers, and so is every Response, Headers and Blob a
 * content script makes (`new Response(...)` is the window's): this
 * script's reads of the page's bytes are refused ("Permission denied to
 * access property \"constructor\"": a subarray of them, readZip's; 1.0.3's
 * project open, its bytes in a Response made here; 1.0.1's Compare), and
 * its streams never finish reading them (DecompressionStream). So the
 * answer is read whole, once, its bytes copied into this script's memory,
 * and given as an object of this script's (Fetched), never a Response:
 * each read of it hands out this script's own copy. Chrome's fetch is the
 * script's own already.
 */
async function ownResponse(r: Response): Promise<Fetched> {
  const page = new Uint8Array(await adopt(r.arrayBuffer()));
  const bytes = new Uint8Array(page.length);
  bytes.set(page);
  const headers = new Map<string, string>();
  for (const h of ["content-type", "content-length", "content-disposition", "etag", "last-modified"]) {
    const v = r.headers.get(h);
    if (v != null) headers.set(h, String(v));
  }
  const text = () => new TextDecoder().decode(bytes);
  return {
    ok: Boolean(r.ok),
    status: Number(r.status),
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: null,
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => text(),
    json: async () => JSON.parse(text()) as unknown,
  };
}
const pageFetch: PageFetch = (u, o) => {
  devMark(`fetch ${String(u).replace(/^.*\/project\/[^/]+/, "")}`);
  // (Firefox: the page's promise adopted first, the answer made this script's own)
  const got: Promise<Fetched> = rawPageFetch === fetch ? fetch(u, o) : adopt(rawPageFetch(u, o)).then(ownResponse);
  return got.then(
    (r) => (devMark(`fetched ${r.status}`), r),
    (e) => (devMark(`fetch failed: ${e}`), Promise.reject(e)),
  );
};

/**
 * A failure a scenario asks for (test/scenarios/startup-errors.json), on the
 * local mock only: the page's `phitex:test-failure` (engine-page,
 * engine-module, worker-fetch, worker-script, build-hold). Never on overleaf.com.
 */
function testFailure(): string | undefined {
  if (location.hostname !== "localhost") return undefined;
  try {
    return localStorage.getItem("phitex:test-failure") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where this tab's start got to, said wherever someone looks before a build
 * has run: the card, the diagnostics button's title, the download's
 * message, Copy debug info and the report. Each step sets it; a failure
 * keeps it and says why (issue #39: a start that never ended said nothing).
 * The start is the editor tab's: Overleaf's detached PDF tab runs none of
 * its own, it is told the editor tab's (`bootTold`), so it says where that
 * start is, and that it built, with its steps, its project and its errors
 * (#60: the detached tab kept its own, never begun, and said "Starting…"
 * for ever over pages it drew).
 */
const boot = {
  /** The step under way, as the card says it ("Downloading the project from Overleaf… (3.1 MB of 12 MB)"). */
  stage: "Starting",
  /** The step's head ("Downloading the project from Overleaf…"): the status text, before a build. */
  head: "Starting…",
  /** When this script started, on the page's clock. */
  t0: performance.now(),
  /** Each step's head, when it began, and how far it got (counts and sizes only: no file names). */
  steps: [] as { h: string; t: number; far: string }[],
  /** What failed, each with the step it stopped (no file names), in order; this script's uncaught errors too. */
  errors: [] as string[],
  /** Whether the start stopped at an error. */
  failed: false,
  /** Whether a build has come in (the core's settled event). */
  built: false,
  /** The project as last read: how many files, how big (no names; the main file's only). */
  read: { files: 0, binaries: 0, bytes: 0, largest: [] as number[], main: "" },
  /** Whose start it is: "" this tab's, else the tab it was told by ("the editor tab"). */
  whose: "",
};
/** The start as told to a detached tab: its state, its clock (t0) on the shared one (performance.timeOrigin's). */
type BootTold = { t: "boot"; boot: Omit<typeof boot, "t0" | "whose">; at: number };
/** The editor tab's: the start told to a detached tab, at each change and when one says hello. */
let bootOut: ((b: BootTold) => void) | undefined;
const bootTold = (): BootTold => {
  const { t0, whose, ...rest } = boot;
  return { t: "boot", boot: rest, at: performance.timeOrigin + t0 };
};
/** The detached tab's: the editor tab's start, taken as this tab's. */
function bootHeard(b: BootTold): void {
  Object.assign(boot, b.boot, { t0: b.at - performance.timeOrigin, whose: "the editor tab" });
  bootShown();
}
/** The status's own drawing, once docked (dockInOverleaf's mirrorStatus): the build's, when the start has built. */
let statusAgain = () => {};
/**
 * The step, as the card says it (with how far: "12 of 3,000"), kept for the
 * rest. `named`: its detail is a file's name, said on the card, never in
 * the debug info.
 */
function reading(panel: Panel, r: Parameters<Panel["reading"]>[0], named = false): void {
  const far = [r.detail, r.total ? `${r.done ?? 0} of ${r.total}` : ""].filter(Boolean).join(", ");
  boot.stage = far ? `${r.h} (${far})` : r.h;
  boot.head = r.h;
  const safe = [named ? "" : r.detail, r.total ? `${r.done ?? 0} of ${r.total}` : ""].filter(Boolean).join(", ");
  const last = boot.steps.at(-1);
  if (last?.h === r.h) last.far = safe;
  else (boot.steps.push({ h: r.h, t: performance.now() - boot.t0, far: safe }), bootTrace?.(`start: ${r.h}`, safe ? { far: safe } : undefined));
  panel.reading(r);
  bootShown();
}
/** The open session's trace, once there is one: the start's steps and failures go in it too. */
let bootTrace: ((k: string, d?: unknown) => void) | undefined;
/** The start stopped at `e`: kept, with its step (for the debug info: the step's head and how far, no names). */
function bootFailed(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const why = `${boot.stage.replace(/…/, "")} failed: ${msg}`;
  const last = boot.steps.at(-1);
  boot.errors.push(`${last ? `${last.h.replace(/…/, "")}${last.far ? ` (${last.far})` : ""}` : "Starting"} failed: ${msg}`);
  bootTrace?.("start: failed", { error: boot.errors.at(-1) });
  boot.stage = why;
  boot.head = "Couldn't start";
  boot.failed = true;
  bootShown();
  return why;
}
/**
 * Before a build, where the start is, where it can be seen: the status text
 * in Overleaf's toolbar (a click opens the timings and Copy debug info) and
 * the diagnostics button's title, never "starting…" with nothing behind it.
 * After a build, the panel's own (onState).
 */
function bootShown(): void {
  bootOut?.(bootTold());
  if (boot.built) return statusAgain();
  const b = document.getElementById("phitex-logs");
  if (b) b.title = `PhiTeX diagnostics · ${boot.stage}`;
  const st = document.getElementById("phitex-status");
  if (st) {
    st.querySelector(".phitex-st-text")!.textContent = boot.head;
    st.querySelector(".phitex-st-more")!.textContent = "· debug info";
    st.title = `${boot.stage}. Click for the details and Copy debug info (PhiTeX)`;
    st.classList.toggle("err", boot.failed);
  }
}
// (this script's own failures, on every page: what a report and Copy debug info say)
addEventListener("error", (e) => void boot.errors.push(`uncaught (${boot.head.replace(/…/, "")}): ${e.message}`));
addEventListener("unhandledrejection", (e) => void boot.errors.push(`unhandled (${boot.head.replace(/…/, "")}): ${(e.reason as Error)?.message ?? String(e.reason)}`));
/** The engine's identity (the formats it ships are named by it: formats/names.txt, web-accessible for this), read once. */
let identity: Promise<string> | undefined;
const engineIdentity = () =>
  (identity ??= fetch(chrome.runtime.getURL("formats/names.txt"))
    .then((r) => (r.ok ? r.text() : ""))
    .then((t) => /^[a-z]+-([0-9a-f]{16})-/m.exec(t)?.[1] ?? "?", () => "?"));
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
/**
 * The debug info's own lines, whatever state the tab is in (the engine never
 * started, the read stuck): the extension, the engine's identity, the
 * browser and system, each step with when it began and how far it got,
 * every error with its step, the project's size (counts and sizes, its
 * main file's name, no other names and no text), and this browser's
 * isolation. The panel adds the build's and the machine's after.
 */
async function bootLines(): Promise<string[]> {
  const m = chrome.runtime.getManifest();
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] } };
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const r = boot.read;
  return [
    `PhiTeX Instant ${m.version_name ?? m.version}, engine identity ${await engineIdentity()}, on ${location.host}`,
    `browser: ${nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", ") || navigator.userAgent}; system: ${nav.userAgentData?.platform || navigator.platform}; ${navigator.hardwareConcurrency ?? "?"} cores`,
    `isolation: crossOriginIsolated ${String(globalThis.crossOriginIsolated)}, SharedArrayBuffer ${typeof SharedArrayBuffer === "function" ? "available" : "missing"}`,
    `start: ${boot.built ? "built" : boot.failed ? "stopped" : "under way"}${boot.whose ? ` (${boot.whose}'s)` : ""}, ${s(performance.now() - boot.t0)} since ${boot.whose ? "it" : "the page"} loaded`,
    ...boot.steps.map((st) => `  ${s(st.t)} ${st.h}${st.far ? ` (${st.far})` : ""}`),
    `project: ${r.files} text files, ${r.binaries} other files, a ${mb(r.bytes)} download${r.largest.length ? `; largest files ${r.largest.map(mb).join(", ")}` : ""}${r.main ? `; main file ${r.main}` : ""}`,
    // (the start's own errors; the document's problems, the badge's, are the panel's line after)
    ...(boot.errors.length ? ["start errors:", ...boot.errors.slice(-12).map((e) => `  ${e}`)] : ["start errors: none"]),
  ];
}

(globalThis as any).__phitexBoot = async () => ({ ...boot, lines: await bootLines() }); // (tests, devtools)

const DETACHED = /^\/project\/[0-9a-f]{24}\/detached\/?$/.test(location.pathname);
/** The editor tab while its PDF is in a separate tab (Overleaf's /detacher, pushed when the PDF is opened in another tab, loaded so when reloaded): it never floats a preview, the PDF tab shows it. */
const detacher = () => /\/detacher\/?$/.test(location.pathname);

// (debug scripts, on the local mock only, never overleaf.com: the storage
// as after the onboarding, so no run clicks through the terms and the tour;
// tools/dev/onboarded.mjs posts it, then reloads)
// ("trace": the session's last events and this script's errors, for a
// browser whose automation can't reach content scripts: Firefox)
const devErrors: string[] = [];
/** (localhost only: where startup got to, for the "trace" above) */
function devMark(m: string): void {
  if (location.hostname === "localhost") devErrors.push(`${Math.round(performance.now())} ${m}`);
}
if (location.hostname === "localhost") {
  addEventListener("error", (e) => devErrors.push(String(e.error?.stack ?? e.message)));
  addEventListener("unhandledrejection", (e) => devErrors.push(String((e.reason as Error)?.stack ?? e.reason)));
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-dev") return;
    if (e.data.type === "onboard") {
      const o = e.data.storage;
      if (o && typeof o === "object") void chrome.storage.local.set(o).then(() => window.postMessage({ src: "phitex-dev", type: "onboarded" }, location.origin));
    } else if (e.data.type === "trace") {
      const s = (globalThis as unknown as { __phitexSession?: { trace: unknown[] } }).__phitexSession;
      window.postMessage({ src: "phitex-dev", type: "traced", trace: JSON.stringify({ session: !!s, trace: s?.trace.slice(-30), errors: devErrors.slice(-30) }) }, location.origin);
    } else if (e.data.type === "state") {
      // ("state": what a Firefox scenario checks (tools/dev/fx-run.mjs): the PDF's hash, a compare's diff.tex)
      void (async () => {
        const s = (globalThis as unknown as { __phitexSession?: { pdf(): Promise<Uint8Array | undefined> } }).__phitexSession;
        const pdf = await s?.pdf().catch(() => undefined);
        // (FNV-1a, here: crypto.subtle's answer would be the page's ArrayBuffer in Firefox)
        let h = 0x811c9dc5;
        for (const b of pdf ?? []) h = Math.imul(h ^ b, 0x01000193) >>> 0;
        const shown = (globalThis as unknown as { __phitexCompare?: { shown(): { texts(): Record<string, string> } } }).__phitexCompare?.shown();
        const state = { session: !!s, pdf: pdf ? `${pdf.length}:${h.toString(16)}` : "", diffTex: shown?.texts()["diff.tex"] ?? null, failed: boot.failed, stage: boot.stage, errors: [...boot.errors, ...devErrors.slice(-30)] };
        window.postMessage({ src: "phitex-dev", type: "stated", state: JSON.stringify(state) }, location.origin);
      })();
    } else if (e.data.type === "exact") {
      // ("exact": Blame worked out to the character (Character detail, spacing counted, moved text its writer's) against
      // the mock's truth (each character's session and author, tools/mock/history-gen.mjs): the characters it got wrong,
      // and those not saved to the history (the editor's own), the history's text being the editor's without them)
      void (async () => {
        let out: unknown;
        try {
          const truth = (await (await fetch(`${location.origin}/project/mock/truth`)).json()) as Record<string, [number, number, string, string][]>;
          const h = (globalThis as unknown as { __phitexHistory: { blame: { blame(f: string[], o: object): Promise<{ commits: { short: string; author: string }[]; files: Record<string, { runs?: [number, number, number][] }> } | string> } } }).__phitexHistory;
          const d = await h.blame.blame(Object.keys(truth), { detail: "char", ws: "count", moved: "keep", skip: [] });
          if (typeof d === "string") throw new Error(d);
          const res: Record<string, { chars: number; wrong: number; unsaved: number; first?: string }> = {};
          for (const [f, runs] of Object.entries(truth)) {
            const want: string[] = [];
            for (const [a, b, v, w] of runs) for (let i = a; i < b; i++) want.push(`${v} ${w}`);
            const got: string[] = [];
            let unsaved = 0;
            for (const [a, b, k] of d.files[f]?.runs ?? []) for (let i = a; i < b; i++) k < 0 ? unsaved++ : got.push(`${d.commits[k].short} ${d.commits[k].author}`);
            let wrong = Math.abs(got.length - want.length), first: string | undefined;
            for (let i = 0; i < Math.min(got.length, want.length); i++) if (got[i] !== want[i]) (wrong++, (first ??= `${i}: ${got[i]} for ${want[i]}`));
            res[f] = { chars: want.length, wrong, unsaved, ...(first ? { first } : {}) };
          }
          out = res;
        } catch (err) {
          out = { error: String(err) };
        }
        window.postMessage({ src: "phitex-dev", type: "exacted", result: JSON.stringify(out) }, location.origin);
      })();
    }
  });
}
/** A detached PDF tab follows this editor tab (then no floating window here: the PDF is there). */
let mirrored = false;
/** Closed docs are fetched again this often (collaborators' edits), and diffed in. */
const FOLLOW_MS = 10_000;

/** Doc paths → ids, from the file tree (every doc the tree has rendered). */
function docIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const e of document.querySelectorAll<HTMLElement>('.file-tree-list [data-file-type="doc"][data-file-id]')) {
    const names: string[] = [];
    for (let li: Element | null = e.closest('[role="treeitem"]'); li; li = li.parentElement?.closest('[role="treeitem"]') ?? null)
      names.unshift(li.getAttribute("aria-label") ?? "");
    ids.set(names.join("/"), e.dataset.fileId!);
  }
  return ids;
}

/**
 * The project's text docs, each on its own: `/entities` for the paths, the
 * file tree for their ids, `/doc/:id/download` for the text (no binaries
 * ever fetched). A doc whose id the tree has not rendered (a folder never
 * opened) comes from the project ZIP, the one fallback.
 */
/** Where the project's binary files go (the core); set once connected. */
let giveBinary: ((path: string, bytes: Uint8Array) => Promise<unknown>) | undefined;
/** And takes one back (a file the project no longer has); set with giveBinary. */
let takeBinary: ((path: string) => Promise<unknown>) | undefined;
/** The project's binary files as last read (a compare's session gets them too). */
let lastBinaries: Record<string, Uint8Array> = {};

/** Overleaf did not hand the project over: its answer to the ZIP's request (`status`), or none (0: the network). */
class NotHanded extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status ? `project download failed: ${status}` : "project download failed: no answer");
    this.status = status;
  }
  /** In plain words, for the card. */
  get plain(): string {
    return notHandedWords(this.status);
  }
}
const notHandedWords = (status: number) => (status ? `Overleaf didn't hand over the project just now (it answered ${status}).` : "Overleaf didn't answer just now.");

async function fetchDocs(panel: Panel, only?: (path: string) => boolean): Promise<Record<string, string>> {
  const t = performance.now();
  const files: Record<string, string> = {};
  if (!only) {
    // (the whole project: its ZIP, every doc's current text and the binary
    // files, figures, in one request, ~1 s; given to the core before the
    // first build. No waiting on the file tree, whose collapsed folders
    // never show their docs' ids)
    reading(panel, { h: "Downloading the project from Overleaf…" });
    const z = await pageFetch(`${project()}/download/zip`, { credentials: "include" }).catch(() => {
      throw new NotHanded(0);
    });
    if (!z.ok) throw new NotHanded(z.status);
    const size = Number(z.headers.get("content-length")) || 0;
    const mb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`);
    // (the bytes as they arrive, said on the card: Chrome's fetch streams
    // them; Firefox's answer was read whole by pageFetch, made the script's own)
    let own: Uint8Array;
    if (z.body && rawPageFetch === fetch) {
      const parts: Uint8Array[] = [];
      let got = 0;
      const rd = z.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        reading(panel, { h: "Downloading the project from Overleaf…", detail: size ? `${mb(got)} of ${mb(size)}` : mb(got), pct: size ? Math.min(100, Math.round((100 * got) / size)) : undefined });
      }
      own = new Uint8Array(got);
      let at = 0;
      for (const p of parts) (own.set(p, at), (at += p.length));
    } else {
      if (size) reading(panel, { h: "Downloading the project from Overleaf…", detail: mb(size) });
      // (pageFetch's answer: this script's own bytes, a copy of its own)
      own = new Uint8Array(await z.arrayBuffer());
    }
    const zbuf = own.buffer as ArrayBuffer;
    devMark(`zip ${zbuf.byteLength} bytes`);
    const { files: zipped, binaries: bin } = await readZip(zbuf, (name, k, n) => reading(panel, { h: "Unpacking the project…", detail: name, done: k + 1, total: n }, true));
    devMark(`unzipped ${Object.keys(zipped).length} files`);
    Object.assign(files, zipped);
    // (a file deleted or renamed in Overleaf since the last read: withdrawn
    // from the core, which then looks for it as a fresh one does)
    const gone = Object.keys(lastBinaries).filter((p) => !(p in bin));
    lastBinaries = bin;
    if (takeBinary) for (const p of gone) await takeBinary(p);
    if (giveBinary) {
      // (figures and other binary files, handed to the engine before the first build)
      const all = Object.entries(bin);
      let given = 0;
      await Promise.all(
        all.map(async ([p, b]) => {
          await giveBinary!(p, b);
          reading(panel, { h: "Handing figures to the engine…", detail: p, done: ++given, total: all.length }, true);
        }),
      );
    }
    const nf = Object.keys(files).length, nb = Object.keys(bin).length;
    const sizes = [...Object.values(zipped).map((t) => t.length), ...Object.values(bin).map((b) => b.length)].sort((a, b) => b - a);
    boot.read = { ...boot.read, files: nf, binaries: nb, bytes: zbuf.byteLength, largest: sizes.slice(0, 3) };
    const others = nb === 1 ? "1 figure or other file" : `${nb} figures and other files`;
    reading(panel, { h: "Project read · checking packages…", detail: `${nf} ${nf === 1 ? "file" : "files"}, ${others}` });
    panel.files(Object.keys(files), [], `in ${((performance.now() - t) / 1000).toFixed(1)} s, with ${others}`);
    return files;
  }
  // (a refresh, of the docs not open: each by its id, those the tree shows;
  // a doc it doesn't show waits for the next refresh or a reload)
  const r = await pageFetch(`${project()}/entities`, { credentials: "include" });
  if (!r.ok) throw new Error(`project listing failed: ${r.status}`);
  const { entities } = (await r.json()) as { entities: { path: string; type: string }[] };
  const ids = docIds();
  await Promise.all(
    entities
      .filter((e) => e.type === "doc")
      .map((e) => e.path.replace(/^\//, ""))
      .filter((p) => only(p) && ids.has(p))
      .map(async (p) => {
        const d = await pageFetch(`${project()}/doc/${ids.get(p)}/download`, { credentials: "include" });
        if (d.ok) files[p] = await d.text();
      }),
  );
  return files;
}

class OverleafHost implements EditorHost {
  private opens: ((f: string, t: string) => void)[] = [];
  private changes: ((f: string, e: Edit[], len?: number, sum?: number) => void)[] = [];
  private panel: Panel;
  constructor(panel: Panel) {
    this.panel = panel;
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.src !== "phitex-hook") return;
      const m = e.data;
      if (!m.file) return;
      if (m.type === "open") for (const cb of this.opens) cb(m.file, m.text);
      else if (m.type === "changes") {
        const es = m.edits.map(([from, to, text]: [number, number, string]) => ({ from, to, text }));
        for (const cb of this.changes) cb(m.file, es, m.len, m.sum);
      }
    });
  }
  loadProject() {
    return fetchDocs(this.panel);
  }
  onOpen(cb: (f: string, t: string) => void) {
    this.opens.push(cb);
  }
  onChanges(cb: (f: string, e: Edit[], len?: number, sum?: number) => void) {
    this.changes.push(cb);
  }
  /** The whole text again (the session's copy differs from the editor's): the hook announces the open file. */
  resend() {
    window.postMessage({ src: "phitex-content", type: "hello" }, location.origin);
  }
  ready() {
    // (the hook announces the open file again: the editor's text, unsaved
    // edits and all, wins over the ZIP's)
    window.postMessage({ src: "phitex-content", type: "hello" }, location.origin);
  }
}

/** Whether the extension was reloaded or updated under this tab (its content script then cut off). */
const contextGone = () => !chrome.runtime?.id;
const GONE = "PhiTeX Instant was updated or reloaded: reload this tab to use it";
/**
 * The tab's engine: an extension page in a hidden iframe of this tab
 * (engine.html, engine.ts), its core a worker there, and a MessagePort to
 * it, as the web demo talks to its worker: requests and replies are
 * structured clones, bytes as they are. Each transport is a core of its own
 * (the tab's, a compare's), gone with its iframe.
 */
class FrameTransport implements CoreTransport {
  /** Whether the core keeps its document's persisted graph (the tab's; a compare's marked-up document keeps none). */
  private graph: boolean;
  constructor(graph = true) {
    this.graph = graph;
  }
  private port!: MessagePort;
  private frame: HTMLIFrameElement | undefined;
  private nextId = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  /**
   * The engine's page in its frame, and its port, once the engine says it
   * started (its worker made), else an error that says why. Before, an
   * engine that never started left every request waiting and the card on
   * "Reading the project" (issue #39). `wait`: told each step, for the card.
   */
  async connect(wait: (step: string) => void = () => {}): Promise<void> {
    const frame = (this.frame = document.createElement("iframe"));
    // (a scenario's failure, on the local mock only: the page missing)
    const test = testFailure();
    frame.src = chrome.runtime.getURL(test === "engine-page" ? "engine-missing.html" : "engine.html");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.display = "none";
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    document.documentElement.append(frame);
    wait("loading its page");
    await loaded;
    const ch = new MessageChannel();
    this.port = ch.port1;
    const started = new Promise<void>((ok, no) => {
      this.port.onmessage = (m: MessageEvent<any>) => {
        const r = m.data;
        if (r.event === "engine") return r.ok ? ok() : no(new Error(r.error));
        if (r.event) return this.events.forEach((f) => f(r));
        this.answer(r.id, r);
      };
    });
    // (the frame gone (its process crashed, the page reloaded under it): what waits answered, and what comes after)
    this.port.addEventListener("close", () => this.lost("the engine's page closed (its frame crashed or was removed)"));
    this.port.onmessageerror = () => this.lost("a message from the engine couldn't be read");
    frame.contentWindow!.postMessage({ src: "phitex-engine", test }, new URL(chrome.runtime.getURL("")).origin, [ch.port2]);
    // (its page loaded: its script answers, the engine started or why not. A page whose script
    // never runs (the browser blocking the extension's frame) can't answer: said as this step)
    wait("its page loaded, waiting for it to answer");
    await started;
    // (the project: the core keeps the document's records under it)
    this.port.postMessage({ id: 0, op: "hello", project: project(), graph: this.graph });
  }
  private answer(id: number, r: CoreRes) {
    this.waiting.get(id)?.(r);
    this.waiting.delete(id);
  }
  /** Why the engine can't answer any more, once it can't: every request waiting answered with it, every later one too. */
  private gone_?: string;
  private lost(why: string) {
    this.gone_ ??= why;
    for (const id of [...this.waiting.keys()]) this.answer(id, { ok: false, error: why } as CoreRes);
    this.events.forEach((f) => f({ event: "trapped", error: why } as unknown as CoreEvent));
  }
  /** Let go of the core (a compare stopped): its iframe, and the core with it. */
  close(): void {
    this.port?.close();
    this.frame?.remove();
  }
  /** Called once if the extension is reloaded or updated under this tab (its iframe gone, the core with it). */
  onGone(cb: () => void) {
    this.gone.push(cb);
  }
  private gone: (() => void)[] = [];
  request(req: CoreReq): Promise<CoreRes> {
    if (contextGone()) {
      this.gone.splice(0).forEach((f) => f());
      return Promise.resolve({ ok: false, error: GONE } as CoreRes);
    }
    if (this.gone_) return Promise.resolve({ ok: false, error: this.gone_ } as CoreRes);
    const id = this.nextId++;
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.port.postMessage({ id, ...req });
    });
  }
  private events: ((e: CoreEvent) => void)[] = [];
  onEvent(cb: (e: CoreEvent) => void) {
    this.events.push(cb);
  }
}

const ZOOMS: [string, string][] = [["fit", "Fit width"], ["0.75", "75%"], ["1", "100%"], ["1.5", "150%"], ["2", "200%"]];

/** Changes' Diff (compare.ts's runner): the real one set once the session is up (the toolbar comes first). */
let diffImpl: ChangesRunner | undefined;
const diffRunner: ChangesRunner = {
  start: (p, look, hide, say, count) => (diffImpl ? diffImpl.start(p, look, hide, say, count) : Promise.reject(new Error("the preview is still starting"))),
  show: (on) => diffImpl?.show(on),
  goto: (k) => diffImpl?.goto(k),
  download: (w) => diffImpl?.download?.(w),
  restyle: (l, hide) => diffImpl?.restyle(l, hide),
  stop: () => diffImpl?.stop(),
  marks: (k) => diffImpl?.marks?.(k) ?? [],
  source: (n) => diffImpl?.source?.(n),
};

/**
 * Your last visit: the history's version when this project was last opened
 * here (more than half an hour ago), kept in the extension's storage by
 * project; `seen` the version now, told once the history's first page is read.
 */
const visits = {
  prev: null as number | null,
  async seen(id: string, v: number): Promise<void> {
    const { visits: all } = (await chrome.storage.local.get("visits")) as { visits?: Record<string, { cur: number; prev: number | null; at: number }> };
    const was = all?.[id];
    const now = Date.now();
    const next = !was ? { cur: v, prev: null, at: now } : now - was.at > 30 * 60e3 && was.cur !== v ? { cur: v, prev: was.cur, at: now } : { ...was, cur: v, at: was.cur === v ? was.at : now };
    this.prev = next.prev;
    await chrome.storage.local.set({ visits: { ...all, [id]: next } });
  },
};

/** Styles for what we add to Overleaf's own DOM (the switch, the toolbar controls, the tip). */
const DOCK_CSS = `
  /* Overleaf's viewer stays laid out, only unseen: pdf.js scrolls it (recompile, SyncTeX) and needs its offsetParent */
  .phitex-on .pdf-viewer { visibility: hidden !important; pointer-events: none !important; }
  /* Overleaf's logs (its compiler's) too, while Instant shows: back as they were on the PDF tab */
  .phitex-on .new-logs-pane, .phitex-on .logs-pane { visibility: hidden !important; pointer-events: none !important; }
  /* Overleaf's SyncTeX arrows, beside the .pdf (not in it), over the ⚡ panel (its z-index 12).
     The body's own class, never body:has(.phitex-on): Chrome then restyles the whole page on
     any node added anywhere (Overleaf's Vim cursor and PDF text layer on each cursor move:
     3,300 elements two or three times a keystroke, 50 -> 200 ms a line) */
  body.phitex-on-page .synctex-controls { z-index: 13 !important; }
  /* in PhiTeX mode, Overleaf's viewer controls go, all but its invert-colors button (which works on ours too) */
  .phitex-on #toolbar-pdf-controls *:not(:has(.theme-toggle-btn)):not(.theme-toggle-btn):not(.theme-toggle-btn *) { display: none !important; }
  /* the right side as wide as its buttons, the left side what is left: too narrow a toolbar
     cuts the left side's status text short (below), never the right side's buttons off */
  .phitex-on .toolbar-pdf-right { display: flex; align-items: center; justify-content: flex-end; flex: 0 0 auto !important; }
  .phitex-on .toolbar-pdf-left { flex: 1 1 auto !important; }
  /* its controls' wrapper keeps only the invert button: no room held for the hidden rest */
  .phitex-on #toolbar-pdf-controls, .phitex-on #toolbar-pdf-controls > * { flex: 0 0 auto !important; width: auto !important; }
  #phitex-controls:not(.compact) .phitex-compact-only { display: none; }
  #phitex-controls.compact .pdfjs-toolbar-buttons, #phitex-controls.compact .pdfjs-page-number-input { display: none; }
  #phitex-switch { margin: 0 4px 0 8px; display: inline-flex; align-items: center; position: relative; }
  #phitex-switch .toggle-switch { margin: 0; }
  /* a narrow PDF pane: "PDF | ⚡" (what the title says in full) */
  #phitex-switch .phitex-sw-word { padding: 0 0 0 .3em !important; }
  #phitex-switch.narrow .phitex-sw-word { display: none; }
  /* what is left over after that: the status text gives way, cut short (its times are a click away) */
  .phitex-on .toolbar-pdf-left { min-width: 0; }
  #phitex-left { min-width: 0; }
  .phitex-on .toolbar-pdf-left > *, #phitex-left > * { flex-shrink: 0; }
  .phitex-on .toolbar-pdf-left > #phitex-left { flex-shrink: 1; min-width: 0; }
  /* the status's slot gives up its spare room; past that the other controls give way (compact, the switch's "PDF | ⚡",
     ± Changes without its word: each decided on the status's cut, leftSpan), its time never cut */
  #phitex-left > #phitex-status { flex: 0 1 220px; min-width: 0; }
  #phitex-left.tight #phitex-changes .button-content { display: none; }
  #phitex-left.bare #phitex-status .phitex-st-text { display: none; }
  #phitex-left.bare > #phitex-status { flex: 0 0 auto; width: auto; }
  #phitex-left.lean #phitex-clean, #phitex-left.lean #phitex-dlmore, #phitex-left.gone > #phitex-status, #phitex-controls.nozoom .dropdown:has(> #phitex-zoom) { display: none !important; }
  /* Overleaf's editor switch pads each label's inner edge more than its outer one: ours centers its text in the pill */
  #phitex-switch .toggle-switch-label > span { padding: 0 var(--spacing-05, 12px) !important; }
  #phitex-controls, #phitex-left { display: none !important; }
  .phitex-on #phitex-controls { display: flex !important; flex: 0 0 auto !important; width: auto !important; }
  .phitex-on #phitex-left { display: inline-flex !important; align-items: center; }
  /* in PhiTeX mode, Overleaf's own logs and download (its compiler's) give way to ours, in the same place */
  .phitex-on .toolbar-pdf-left > :not(.compile-button-group):not(#phitex-switch):not(#phitex-left) { display: none !important; }
  .phitex-badge:empty { display: none; }
  #phitex-dlgroup { position: relative; align-items: center; }
  /* (side by side, never over each other: the caret pulled over the download button hid its hover box's right edge, its icon looked off its centre) */
  #phitex-dlgroup #phitex-dl { padding: 0 4px; place-items: center; }
  #phitex-dlgroup .phitex-caret { width: 16px; min-width: 16px; margin-left: 0; padding: 0; place-items: center; }
  #phitex-dlgroup .phitex-caret .material-symbols { font-size: 16px; }
  #phitex-dlmenu .dropdown-item { display: flex; justify-content: space-between; gap: 12px; }
  .phitex-toast { animation: phitex-callout-in .35s cubic-bezier(.2,1.2,.4,1); cursor: pointer; }
  .phitex-badge { position: absolute; top: -2px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 9999px;
    font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; color: #fff; background: var(--bg-info-01, #366cbf); }
  .phitex-badge.warning { background: var(--bg-warning-01, #8f5514); } .phitex-badge.error { background: var(--bg-danger-01, #b83a33); }
  #phitex-zoom-menu { min-width: 120px; }
  /* the build's status, as the panel says it ("Built · 42 ms"): Overleaf's toolbar text, its timings on a click */
  #phitex-status { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums;
    width: 220px; overflow: hidden; }
  #phitex-status .phitex-st-text { font-weight: 600; }
  #phitex-status .phitex-st-more { opacity: .75; }
  /* (a slot of 220 px: its words change with every build, the buttons after it never move; long words cut short, its time never) */
  #phitex-status { justify-content: flex-start; }
  #phitex-status > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #phitex-status .phitex-st-text { flex-shrink: 1; } #phitex-status .phitex-st-more { flex-shrink: 0; }
  #phitex-status.err .phitex-st-text { color: var(--content-danger-dark, #e36d66); }
  [data-theme="light"] #phitex-status.err .phitex-st-text { color: var(--content-danger, #b83a33); }
  #phitex-status:empty, #phitex-status .phitex-st-text:empty + .phitex-st-more { display: none; }
  #phitex-consent .modal { z-index: 1070; } #phitex-consent .modal-backdrop { z-index: 1065; }
  #phitex-consent .form-check { margin-top: 12px; }
  #phitex-news .popover-body { max-height: 50vh; overflow: auto; }
  #phitex-news .phitex-news-title { font-weight: 700; margin-bottom: 4px; }
  #phitex-news ul { padding-left: 18px; margin: 0 0 10px; }
  #phitex-news li { margin-bottom: 4px; }
  label.phitex-dot-new { position: relative; }
  label.phitex-dot-new::before { content: ""; position: absolute; top: 2px; right: 4px; width: 7px; height: 7px; border-radius: 50%;
    background: #5b8fd6; box-shadow: 0 0 0 2px var(--bg-dark-primary, #1b222c); }
  #phitex-tour .phitex-hl-demo { margin: 10px 0; padding: 8px; border-radius: 8px; background: rgb(0 0 0 / 22%); display: grid; gap: 8px; font-size: 12px; }
  #phitex-tour .phitex-hl-ed { position: relative; font-family: "DM Mono", monospace; color: #a9c4f0; }
  #phitex-tour .phitex-hl-caret { position: absolute; top: 1px; left: 7ch; width: 2px; height: 1.2em; background: currentColor;
    animation: phitex-caret 3.6s steps(1) infinite, phitex-blink .6s steps(1) infinite; }
  #phitex-tour .phitex-hl-page { font-family: "Noto Serif", serif; color: #1b222c; background: #fff; border-radius: 3px; padding: 4px 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 30%); }
  #phitex-tour .phitex-hl-page { position: relative; }
  #phitex-tour .phitex-hl-page span, #phitex-tour .phitex-hl-ed span { border-radius: 2px; }
  #phitex-tour [data-mode="cursor"] .phitex-hl-page span { animation: phitex-hl 3.6s steps(1) infinite; }
  #phitex-tour [data-mode="cursor"] .phitex-hl-page .w2 { animation-delay: -2.4s; }
  #phitex-tour [data-mode="cursor"] .phitex-hl-page .w3 { animation-delay: -1.2s; }
  #phitex-tour .phitex-hl-click { display: none; position: absolute; font-style: normal; font-size: 14px; color: #1b222c; }
  #phitex-tour [data-mode="select"] .phitex-hl-caret, #phitex-tour [data-mode="dblclick"] .phitex-hl-caret { display: none; }
  #phitex-tour [data-mode="select"] .e2, #phitex-tour [data-mode="select"] .e3 { animation: phitex-sel 3.6s steps(1) infinite; }
  #phitex-tour [data-mode="select"] .w2, #phitex-tour [data-mode="select"] .w3 { animation: phitex-selpage 3.6s steps(1) infinite; }
  @keyframes phitex-sel { 0% { background: transparent; } 30%, 85% { background: rgb(91 143 214 / 55%); } }
  @keyframes phitex-selpage { 0% { background: transparent; } 30%, 85% { background: rgb(255 214 0 / 70%); } }
  #phitex-tour [data-mode="dblclick"] .phitex-hl-click { display: block; left: 5.2em; top: 1.1em; animation: phitex-dbl 3.6s ease-out infinite; }
  #phitex-tour [data-mode="dblclick"] .w2 { animation: phitex-selpage 3.6s steps(1) infinite; animation-delay: .4s; }
  #phitex-tour [data-mode="dblclick"] .e2 { animation: phitex-sel 3.6s steps(1) infinite; animation-delay: .4s; }
  @keyframes phitex-dbl { 0%, 20% { opacity: 0; transform: translate(10px, 8px); } 30% { opacity: 1; transform: none; } 34%, 42% { transform: scale(.8); } 38%, 46% { transform: none; } 80% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes phitex-caret { 0% { left: 7ch; } 33.3% { left: 14ch; } 66.6% { left: 19ch; } }
  @keyframes phitex-blink { 50% { opacity: .3; } }
  @keyframes phitex-hl { 0% { background: rgb(255 214 0 / 70%); } 33.3% { background: transparent; } }
  .phitex-cmp-demo { position: relative; margin: 10px 0 2px; padding: 10px 12px 30px; border-radius: 6px; background: #fff; color: #1b222c; font: 13px/1.5 "Noto Serif", Georgia, serif; }
  .phitex-cmp-demo .del { animation: phitex-cmp-del 6s ease-in-out infinite; }
  .phitex-cmp-demo .add { display: inline-block; max-width: 0; overflow: hidden; vertical-align: bottom; white-space: nowrap; color: #1d4ed8;
    text-decoration: underline wavy #1d4ed8; text-underline-offset: 3px; animation: phitex-cmp-add 6s ease-in-out infinite; }
  .phitex-cmp-demo .tag { position: absolute; right: 8px; bottom: 7px; padding: 3px 8px; border-radius: 9px; font: 600 11px/1 "Noto Sans", sans-serif;
    color: #fff; background: #1d3e72; opacity: 0; animation: phitex-cmp-tag 6s ease-in-out infinite; }
  .phitex-cmp-demo .ver { position: absolute; left: 12px; right: 76px; bottom: 9px; height: 12px; font: 11px/12px "Noto Sans", sans-serif; color: #6b7280; }
  .phitex-cmp-demo .ver i { position: absolute; left: 0; font-style: normal; white-space: nowrap; }
  .phitex-cmp-demo .v0 { animation: phitex-cmp-v0 6s steps(1) infinite; }
  .phitex-cmp-demo .v1 { opacity: 0; animation: phitex-cmp-v1 6s steps(1) infinite; }
  @keyframes phitex-cmp-del { 0%, 30% { color: #1b222c; text-decoration: none; } 40%, 92% { color: #b91c1c; text-decoration: line-through 2px #b91c1c; } 100% { color: #1b222c; } }
  @keyframes phitex-cmp-add { 0%, 45% { max-width: 0; } 60%, 92% { max-width: 6em; } 100% { max-width: 0; } }
  @keyframes phitex-cmp-tag { 0%, 62% { opacity: 0; transform: translateY(6px); } 70%, 92% { opacity: 1; transform: none; } 100% { opacity: 0; } }
  @keyframes phitex-cmp-v0 { 0% { opacity: 1; } 31% { opacity: 0; } }
  @keyframes phitex-cmp-v1 { 0% { opacity: 0; } 31% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .phitex-cmp-demo * { animation: none !important; } .phitex-cmp-demo .add { max-width: 6em; } .phitex-cmp-demo .del { color: #b91c1c; text-decoration: line-through 2px #b91c1c; } .phitex-cmp-demo .v0 { opacity: 0; } .phitex-cmp-demo .v1, .phitex-cmp-demo .tag { opacity: 1; } }
  #phitex-tour .phitex-choice { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  #phitex-tour .phitex-choice small { opacity: .8; }
  .phitex-dots { display: flex; gap: 5px; justify-content: center; margin-top: 10px; }
  .phitex-dots span { width: 6px; height: 6px; border-radius: 50%; background: rgb(255 255 255 / 25%); transition: all .2s; }
  .phitex-dots span.on { width: 16px; border-radius: 3px; background: #5b8fd6; }
  .phitex-ring { position: relative; outline: 2px solid #5b8fd6 !important; outline-offset: 2px; border-radius: 6px;
    animation: phitex-ringo 1.3s ease-out infinite; }
  phitex-preview.phitex-ring { outline-offset: -4px; }
  @keyframes phitex-ringo { 50% { outline-color: rgb(91 143 214 / 30%); } }
  #phitex-tip .phitex-demo { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; margin: 10px 0 4px; padding: 8px;
    border-radius: 8px; background: rgb(0 0 0 / 22%); font-size: 12px; }
  #phitex-tip .phitex-demo code { color: #a9c4f0; white-space: nowrap; overflow: hidden; border-right: 2px solid currentColor;
    width: 0; animation: phitex-type 2.4s steps(9) 1s infinite; font-family: "DM Mono", monospace; }
  #phitex-tip .phitex-demo .phitex-arrow { color: #a9c4f0; animation: phitex-zip 2.4s ease-in 1s infinite; }
  #phitex-tip .phitex-demo .phitex-mini { justify-self: end; font-family: "Noto Serif", serif; color: #1b222c; background: #fff; border-radius: 3px;
    padding: 2px 8px; box-shadow: 0 2px 6px rgb(0 0 0 / 30%); opacity: .25; animation: phitex-paint 2.4s steps(1) 1s infinite; }
  @keyframes phitex-type { 0% { width: 0; } 55%, 100% { width: 9ch; } }
  @keyframes phitex-zip { 0%, 55% { transform: translateX(-4px); opacity: .3; } 62% { transform: translateX(6px); opacity: 1; } 100% { opacity: .3; } }
  @keyframes phitex-paint { 0%, 60% { opacity: .25; } 61%, 100% { opacity: 1; } }
  /* (the switch's ⚡ label, ringed by the tip (callout.ts's .phitex-pulse): lit, round) */
  label.phitex-pulse { border-radius: 9999px; background: rgb(91 143 214 / 25%); color: #fff !important; }
  @media (prefers-reduced-motion: reduce) {
    .phitex-ring, #phitex-tip .phitex-demo *, #phitex-tour .phitex-hl-demo * { animation: none !important; }
    #phitex-tip .phitex-demo code { width: 9ch; } #phitex-tip .phitex-demo .phitex-mini { opacity: 1; }
    #phitex-tour .phitex-hl-page .w1 { background: rgb(255 214 0 / 70%); }
  }`;

/**
 * The preview docked in Overleaf's PDF pane: a PDF | PhiTeX switch in its
 * toolbar (Overleaf's own toggle-switch markup and CSS), our controls in
 * its toolbar's right (its own buttons), our page in place of its viewer
 * (hidden, not removed). Checked again and again: React may render the
 * toolbar anew, the pane may open or close. Without the pane or its
 * toolbar (layout changed upstream, PDF closed), the panel floats: the
 * fallback.
 */
type Dock = { toggle(): boolean; tour(): void; news(): void; stop(): void; resume(): void };

function dockInOverleaf(panel: Panel): Dock {
  const PANE = ".pdf.full-size, .ide-redesign-pdf-container .pdf, .pdf";
  /** Without Overleaf's PDF pane this long after load, the preview floats (the fallback). */
  const FALLBACK_AFTER_MS = 8000;
  /** The full controls' width (⌃ ⌄, page, − +, zoom), and some air. */
  const FULL_CONTROLS_PX = 260;
  /** What the toolbar's right side needs with the full controls (measured, FULL_CONTROLS_PX until then). */
  let fullRight = FULL_CONTROLS_PX;
  const started = performance.now();
  const style = document.createElement("style");
  style.textContent = DOCK_CSS;
  document.head.append(style);
  // (the popovers' styles, their animations the toast's too)
  calloutStyle();
  let mode: "pdf" | "phitex" = "pdf";
  /** (read after an await: `set` may have changed it, or refused) */
  const viewNow = () => mode;
  /** The tip shows on every load (on Overleaf's PDF) until "Don't show again". */
  let tipOff = true;
  let newsPending = false;
  const loadedAt = performance.now();
  chrome.storage.local.get(["view", "tipOff", "accepted"]).then(async ({ view, tipOff: off, accepted: a }) => {
    if (view === "phitex" || view === "pdf") mode = view;
    if (mode === "phitex" && a !== TERMS) mode = "pdf";
    tipOff = !!off;
    tick();
    if (!tipOff) setTimeout(tip, 1500);
    // (news after the tip, never both; shown by tick() once the switch exists)
    const { newsSeen, newsOff } = await chrome.storage.local.get(["newsSeen", "newsOff"]);
    newsPending = !newsOff && unseen(newsSeen as string | undefined, chrome.runtime.getManifest().version).length > 0;
  });
  let accepted = false;
  chrome.storage.local.get("accepted").then(({ accepted: a }) => (accepted = a === TERMS));

  /** Before the first use: an unofficial, experimental extension, as is, at the user's own risk. Overleaf's modal markup. */
  function consent(): Promise<boolean> {
    if (accepted) return Promise.resolve(true);
    // (one thing at a time: the terms, alone)
    for (const id of ["phitex-consent", "phitex-news", "phitex-tip", "phitex-tour"]) document.getElementById(id)?.remove();
    return new Promise((done) => {
      const m = document.createElement("div");
      m.id = "phitex-consent";
      m.replaceChildren(html`<div class="modal-backdrop fade show"></div>
        <div class="modal fade show d-block" role="dialog" aria-modal="true" aria-labelledby="phitex-consent-title" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered"><div class="modal-content">
            <div class="modal-header"><h4 class="modal-title" id="phitex-consent-title">⚡ Instant: an unofficial extension</h4></div>
            <div class="modal-body">
              <p><b>PhiTeX Instant is not part of Overleaf</b>, and is not made, endorsed or supported by Overleaf. It is an
              <b>unofficial, experimental</b> browser extension that typesets LaTeX in your browser.</p>
              <p>It runs locally: your documents are not sent anywhere (TeX packages it doesn't bundle are downloaded by name from TeX Live's files). Its preview and PDF can differ from, or be missing what,
              Overleaf's compiler makes. For anything that matters, use Overleaf's <b>PDF</b>.</p>
              <p class="small text-muted">${asIs(chrome.runtime.getURL("LICENSE.txt"))}</p>
              <div class="form-check"><input class="form-check-input" type="checkbox" id="phitex-consent-check">
                <label class="form-check-label" for="phitex-consent-check">${AGREE}</label></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-c="no">Cancel</button>
              <button type="button" class="btn btn-primary" data-c="yes" disabled>Enable ⚡ Instant</button>
            </div>
          </div></div>
        </div>`);
      document.body.append(m);
      const check = m.querySelector<HTMLInputElement>("#phitex-consent-check")!;
      const yes = m.querySelector<HTMLButtonElement>('[data-c="yes"]')!;
      check.onchange = () => (yes.disabled = !check.checked);
      const finish = (ok: boolean) => {
        m.remove();
        if (ok) {
          accepted = true;
          void chrome.storage.local.set({ accepted: TERMS });
        }
        done(ok);
      };
      yes.onclick = () => finish(true);
      m.querySelector<HTMLElement>('[data-c="no"]')!.onclick = () => finish(false);
      m.addEventListener("keydown", (e) => e.key === "Escape" && finish(false));
      check.focus();
    });
  }

  const set = async (m: "pdf" | "phitex") => {
    if (m === "phitex" && !(await consent())) {
      // (not accepted: stay on Overleaf's PDF)
      mode = "pdf";
      tick();
      return;
    }
    mode = m;
    void chrome.storage.local.set({ view: m });
    if (m === "phitex") hideTip();
    tick();
  };

  function switchEl(left: Element): HTMLElement {
    let sw = document.getElementById("phitex-switch");
    if (sw && left.contains(sw)) return sw;
    sw?.remove();
    sw = document.createElement("div");
    sw.id = "phitex-switch";
    sw.className = "editor-toggle-switch";
    sw.setAttribute("aria-label", "Preview: Overleaf's PDF or PhiTeX's");
    sw.innerHTML = `<form><fieldset class="toggle-switch"><legend class="visually-hidden">Preview</legend>
      <input type="radio" name="phitex-view" id="phitex-v-pdf" class="toggle-switch-input" value="pdf">
      <label for="phitex-v-pdf" class="toggle-switch-label" title="Overleaf's compiled PDF"><span>PDF</span></label>
      <input type="radio" name="phitex-view" id="phitex-v-phitex" class="toggle-switch-input" value="phitex">
      <label for="phitex-v-phitex" class="toggle-switch-label" title="⚡ Instant: added by the unofficial PhiTeX extension, not part of Overleaf (experimental) · Alt+Shift+P"><span>⚡<span class="phitex-sw-word">Instant</span></span></label>
    </fieldset></form>`;
    sw.addEventListener("change", (e) => void set((e.target as HTMLInputElement).value as "pdf" | "phitex"));
    left.append(sw);
    return sw;
  }

  /** Overleaf's viewer controls, markup for markup (so they look and theme the same), driving ours. */
  function controlsEl(right: Element): HTMLElement {
    let c = document.getElementById("phitex-controls");
    if (c && right.contains(c)) return c;
    c?.remove();
    c = document.createElement("div");
    c.id = "phitex-controls";
    c.className = "pdfjs-viewer-controls phitex-keep";
    const gbtn = (id: string, icon: string, label: string) =>
      html`<button type="button" id="${id}" aria-label="${label}" title="${label}" class="d-inline-grid pdf-toolbar-btn pdfjs-toolbar-button btn btn-ghost"><span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">${icon}</span></span></button>`;
    // (the last: compact, as Overleaf's own narrow layout, page and zoom steps behind ⋯; then ⚡ Instant's Settings, one dialog in every host, the viewer's)
    c.replaceChildren(html`<div role="group" class="pdfjs-toolbar-buttons btn-group">${gbtn("phitex-prev", "keyboard_arrow_up", "Previous page")}${gbtn("phitex-next", "keyboard_arrow_down", "Next page")}</div>
      <div class="pdfjs-page-number-input"><form id="phitex-pform"><input id="phitex-page" aria-label="Page" inputmode="numeric" value="1"></form><span id="phitex-pages">/ 1</span></div>
      <div class="pdfjs-zoom-controls"><div role="group" class="pdfjs-toolbar-buttons btn-group">${gbtn("phitex-zout", "remove", "Zoom out")}${gbtn("phitex-zin", "add", "Zoom in")}</div>
      <div class="dropdown"><button type="button" id="phitex-zoom" aria-expanded="false" aria-label="PhiTeX zoom level" class="pdf-toolbar-btn pdfjs-zoom-dropdown-button small dropdown-toggle btn btn-link">100%</button>
      <ul class="dropdown-menu dropdown-menu-end" id="phitex-zoom-menu" role="menu">${ZOOMS.map(([v, l]) => html`<li><button type="button" class="dropdown-item" data-zoom="${v}">${l}</button></li>`)}<li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="clean" title="Read the project again and typeset it from the start (PhiTeX)">Clean rebuild</button></li></ul></div></div>
      <div class="dropdown phitex-compact-only"><button type="button" id="phitex-more" aria-label="More" class="d-inline-grid pdf-toolbar-btn pdfjs-toolbar-popover-button btn btn-ghost"><span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">more_horiz</span></span></button>
      <ul class="dropdown-menu dropdown-menu-end" id="phitex-more-menu" role="menu"><li><button type="button" class="dropdown-item" data-act="clean" title="Read the project again and typeset it from the start (PhiTeX)">Clean rebuild</button></li><li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="prev">Previous page</button></li><li><button type="button" class="dropdown-item" data-act="next">Next page</button></li><li><hr class="dropdown-divider"></li><li><button type="button" class="dropdown-item" data-act="zin">Zoom in</button></li><li><button type="button" class="dropdown-item" data-act="zout">Zoom out</button></li></ul></div>${gbtn("phitex-settings", "settings", "⚡ Instant settings")}`);
    const q = (id: string) => c!.querySelector<HTMLElement>(`#${id}`)!;
    q("phitex-prev").onclick = () => panel.prev();
    q("phitex-next").onclick = () => panel.next();
    q("phitex-zout").onclick = () => panel.zoomStep(-1);
    q("phitex-zin").onclick = () => panel.zoomStep(1);
    q("phitex-settings").onclick = () => void panel.settings();
    q("phitex-pform").onsubmit = (e) => {
      e.preventDefault();
      const k = Number((q("phitex-page") as HTMLInputElement).value);
      if (k >= 1) panel.goPage(k - 1);
    };
    const menus: HTMLElement[] = [];
    const dropdown = (button: HTMLElement, menu: HTMLElement) => {
      menus.push(menu);
      button.onclick = (e) => {
        e.stopPropagation();
        const open = !menu.classList.contains("show");
        for (const m of menus) m.classList.remove("show");
        menu.classList.toggle("show", open);
        button.setAttribute("aria-expanded", String(open));
        Object.assign(menu.style, open ? { position: "absolute", inset: "100% 0 auto auto" } : {});
      };
      menu.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom], [data-act]");
        const act = b?.dataset.act;
        if (b?.dataset.zoom) panel.zoomTo(b.dataset.zoom);
        if (act === "clean") panel.clean();
        if (act === "prev") panel.prev();
        if (act === "next") panel.next();
        if (act === "zin") panel.zoomStep(1);
        if (act === "zout") panel.zoomStep(-1);
        menu.classList.remove("show");
      };
    };
    dropdown(q("phitex-zoom"), q("phitex-zoom-menu"));
    dropdown(q("phitex-more"), q("phitex-more-menu"));
    document.addEventListener("click", () => menus.forEach((m) => m.classList.remove("show")));
    const native = right.querySelector("#toolbar-pdf-controls");
    if (native) native.after(c);
    else right.append(c);
    return c;
  }

  const compiledLink = () => document.querySelector<HTMLAnchorElement>('.toolbar-pdf-left a[aria-label="Download PDF"][href]');

  /** The first Instant download says what it is, once: Overleaf's popover, under the button. */
  function explainOnce(anchor: Element): void {
    chrome.storage.local.get("dlExplained").then(({ dlExplained }) => {
      if (dlExplained) return;
      void chrome.storage.local.set({ dlExplained: true });
      const b = anchor.querySelector("#phitex-dlgroup")!.getBoundingClientRect();
      const t = document.createElement("div");
      t.className = "popover bs-popover-bottom show phitex-toast";
      t.setAttribute("role", "status");
      t.innerHTML = `<div class="popover-body">This is the <b>⚡ Instant</b> preview's PDF (PhiTeX, experimental), named <code>…-instant.pdf</code>.
        Overleaf's compiled PDF is in the <b>▾</b> menu, or on the PDF tab.</div>`;
      Object.assign(t.style, { position: "fixed", left: `${Math.max(8, b.left - 20)}px`, top: `${b.bottom + 8}px`, maxWidth: "280px", zIndex: "1060" });
      document.body.append(t);
      setTimeout(() => t.remove(), 7000);
      t.onclick = () => t.remove();
    });
  }

  /**
   * The panel's status ("Built · 42 ms", "Built with 1 error"), from its
   * state (ViewState.status), shown in the toolbar's (the panel's own bar is
   * hidden here, Overleaf's toolbar being the bar).
   */
  let statusNow: ViewState["status"] | null = null;
  /** The problems the last build said (the badge's count): the diagnostics button opens their list whenever there are any. */
  let problemsNow = 0;
  statusAgain = () => mirrorStatus();
  function mirrorStatus(st: ViewState["status"] | null = statusNow): void {
    statusNow = st;
    // (before a build: where the start is, bootShown's)
    if (!boot.built) return bootShown();
    if (st) statusLine.set({ text: st.text, more: st.more, err: st.err });
  }
  // (drawn calmly: at most four times a second, the latest, so a reader can follow it while builds come 30 a second)
  const statusLine = new Calm<{ text: string; more: string; err: boolean }>((st) => {
    const b = document.getElementById("phitex-status");
    if (!b) return;
    b.querySelector(".phitex-st-text")!.textContent = st.text;
    b.querySelector(".phitex-st-more")!.textContent = st.more ? `· ${st.more}` : "";
    b.classList.toggle("err", st.err);
    // (its title says the state it shows, the start's no more)
    b.title = `${st.text}${st.more ? ` · ${st.more}` : ""}. Click for the last build's times (PhiTeX)`;
  });

  /** In Overleaf's left toolbar, where its logs and download are: ours (PhiTeX's diagnostics and PDF). */
  /**
   * Overleaf's Recompile, the switch, then what the mode shows (⚡ Instant's
   * buttons, or Overleaf's logs and download): the switch stays put when it is
   * flipped. (After the mode's buttons, it moved by their difference.)
   */
  function place(left: Element, sw: HTMLElement, l: HTMLElement): void {
    const group = left.querySelector(":scope > .compile-button-group");
    if (group ? group.nextElementSibling !== sw : left.firstElementChild !== sw) group ? group.after(sw) : left.prepend(sw);
    if (sw.nextElementSibling !== l) sw.after(l);
  }

  function leftEl(left: Element): HTMLElement {
    let l = document.getElementById("phitex-left");
    if (l && left.contains(l)) return l;
    l?.remove();
    l = document.createElement("div");
    l.id = "phitex-left";
    l.innerHTML =
      // (a clean recompile of ⚡ Instant alone: the project read again, typeset from the start)
      `<button type="button" id="phitex-clean" aria-label="Clean rebuild (Instant)" title="⚡ Instant: clean rebuild, the project read again and typeset from the start (PhiTeX)" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">refresh</span></span></button>` +
      `<button type="button" id="phitex-logs" aria-label="PhiTeX diagnostics" title="PhiTeX diagnostics" class="d-inline-grid pdf-toolbar-btn toolbar-item log-btn btn btn-link" style="position: relative;">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">description</span></span>` +
      `<span class="phitex-badge" id="phitex-badge"></span></button>` +
      // (the build's status, mirrored from the panel's own bar, hidden here: Overleaf's toolbar is the bar)
      `<button type="button" id="phitex-status" aria-label="The last build's times (PhiTeX)" title="The last build's times: click for the details (PhiTeX)" class="pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="phitex-st-text"></span><span class="phitex-st-more"></span></button>` +
      // (download what you see: this tab's PDF; the other one in the ▾ menu)
      `<div class="dropdown btn-group" id="phitex-dlgroup">` +
      `<button type="button" id="phitex-dl" aria-label="Download the Instant PDF" title="Download the ⚡ Instant PDF (PhiTeX, experimental)" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
      `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">download</span></span></button>` +
      `<button type="button" id="phitex-dlmore" aria-label="Which PDF to download" title="Which PDF to download" aria-expanded="false" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link phitex-caret">` +
      `<span class="material-symbols" aria-hidden="true" translate="no">expand_more</span></button>` +
      `<ul class="dropdown-menu" id="phitex-dlmenu" role="menu">` +
      `<li><button type="button" class="dropdown-item" data-dl="instant">⚡ Instant PDF <span class="text-muted small">PhiTeX, experimental</span></button></li>` +
      `<li><button type="button" class="dropdown-item" data-dl="compiled">Compiled PDF <span class="text-muted small">Overleaf</span></button></li></ul></div>`;
    l.querySelector<HTMLElement>("#phitex-clean")!.onclick = () => panel.clean();
    // (the problems' list whenever a build has said any, the badge's, whatever the start's state; with none and no
    // build yet: the start's step or error, and Copy debug info, as the status's click opens them)
    l.querySelector<HTMLElement>("#phitex-logs")!.onclick = (e) => {
      if (boot.built || problemsNow) return panel.diagnostics();
      e.stopPropagation();
      panel.msg(boot.failed ? boot.stage : `No build yet: ⚡ Instant is at "${boot.stage}".`, boot.failed);
      panel.timingAt(e.currentTarget as HTMLElement);
    };
    // (the last build's times under the button, as the panel's own status opens them; the settings are the zoom menu's)
    const stBtn = l.querySelector<HTMLElement>("#phitex-status")!;
    stBtn.onclick = (e) => (e.stopPropagation(), panel.timingAt(stBtn));
    const menu = l.querySelector<HTMLElement>("#phitex-dlmenu")!,
      more = l.querySelector<HTMLElement>("#phitex-dlmore")!;
    const instant = () => {
      panel.pdf();
      explainOnce(l!);
    };
    l.querySelector<HTMLElement>("#phitex-dl")!.onclick = instant;
    more.onclick = (e) => {
      e.stopPropagation();
      // (Overleaf's compiled PDF: its own download link, there once it has compiled)
      const native = compiledLink();
      const item = menu.querySelector<HTMLButtonElement>('[data-dl="compiled"]')!;
      item.disabled = !native;
      item.title = native ? "The PDF of Overleaf's last compile" : "Recompile first: Overleaf has no PDF yet";
      const open = !menu.classList.contains("show");
      menu.classList.toggle("show", open);
      more.setAttribute("aria-expanded", String(open));
      Object.assign(menu.style, open ? { position: "absolute", inset: "100% auto auto 0" } : {});
    };
    menu.onclick = (e) => {
      const which = (e.target as HTMLElement).closest<HTMLElement>("[data-dl]")?.dataset.dl;
      menu.classList.remove("show");
      if (which === "instant") instant();
      if (which === "compiled") compiledLink()?.click();
    };
    document.addEventListener("click", () => menu.classList.remove("show"));
    // (Changes: Diff and Blame, one popover under its own toolbar button, diffui.ts)
    changesButton(l, panel);
    left.append(l);
    // (a new button, empty: the status drawn in it at once)
    statusLine.reset();
    mirrorStatus();
    return l;
  }

  panel.onState((s) => {
    mirrorStatus(s.status);
    const c = document.getElementById("phitex-controls");
    if (c) {
      const input = c.querySelector<HTMLInputElement>("#phitex-page")!;
      if (document.activeElement !== input) input.value = s.pages ? String(s.page + 1) : "0";
      input.setAttribute("aria-label", `Page ${s.page + 1}, Current Page`);
      c.querySelector("#phitex-pages")!.textContent = `/ ${s.pages}`;
      (c.querySelector("#phitex-prev") as HTMLButtonElement).disabled = s.page <= 0;
      (c.querySelector("#phitex-next") as HTMLButtonElement).disabled = s.page >= s.pages - 1;
      c.querySelector("#phitex-zoom")!.textContent = `${s.percent}%`;
    }
    problemsNow = s.diagCount;
    const b = document.getElementById("phitex-badge");
    if (b) {
      b.textContent = s.diagCount ? String(s.diagCount) : "";
      b.className = `phitex-badge ${s.diagWorst}`;
      // (before a build, the step the start is at, or why it stopped, not "starting…" for ever)
      document.getElementById("phitex-logs")!.title = `PhiTeX diagnostics${s.diagCount ? ` (${s.diagCount})` : ""} · ${boot.built ? s.chip : boot.stage}`;
    }
  });

  /** The first-run tip, pointing at the switch (callout.ts). */
  let tipBox: Callout | undefined;
  function tip(): void {
    const sw = document.getElementById("phitex-switch");
    if (tipOff || mode !== "pdf" || !sw || tipBox) return;
    const label = sw.querySelector('label[for="phitex-v-phitex"]') as HTMLElement;
    const never = h("button", { type: "button", class: "btn btn-link btn-sm phitex-callout-never" }, "Don't show again");
    const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Not now");
    const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "⚡ Try it");
    tipBox = callout({
      id: "phitex-tip",
      label: "Try the PhiTeX preview",
      anchor: label,
      shiny: true,
      header: [h("span", { class: "phitex-callout-icon", "aria-hidden": "true" }, "⚡"), "New: the unofficial PhiTeX extension"],
      body: [
        html`No more Recompile: PhiTeX repaints this page <b>as you type</b>, incrementally, in milliseconds, right in your browser. Nothing leaves it.
        <div class="phitex-demo" aria-hidden="true"><code>Hello TeX</code><span class="phitex-arrow">⚡→</span><span class="phitex-mini">Hello TeX</span></div>
        <div class="small text-muted" style="margin-top:6px">An unofficial browser extension, not an Overleaf feature. Experimental. Overleaf's PDF is one click away.</div>`,
      ],
      actions: [never, no, yes],
      onHide: () => (tipBox = undefined),
    });
    yes.onclick = async () => {
      await set("phitex");
      if (viewNow() !== "phitex") return;
      const { toured } = await chrome.storage.local.get("toured");
      if (!toured) setTimeout(() => void tour(0), 700);
    };
    no.onclick = hideTip;
    never.onclick = () => {
      tipOff = true;
      void chrome.storage.local.set({ tipOff: true });
      hideTip();
    };
  }

  /** Until the next load. */
  function hideTip(): void {
    tipBox?.hide();
  }

  /** What's new: once after an update (or from settings), in the tip's style. */
  async function whatsNew(force = false): Promise<void> {
    const current = chrome.runtime.getManifest().version;
    const { newsSeen } = await chrome.storage.local.get("newsSeen");
    const items: News[] = force ? unseen(undefined, current).slice(0, 3) : unseen(newsSeen as string | undefined, current);
    const sw = document.getElementById("phitex-switch");
    if (!items.length || !sw || document.getElementById("phitex-news") || document.getElementById("phitex-tip")) return;
    const label = sw.querySelector('label[for="phitex-v-phitex"]') as HTMLElement;
    const links = [items[0].link, SUPPORT]
      .filter((l): l is { label: string; href: string } => !!l)
      .map((l) => h("a", { class: "btn btn-secondary btn-sm", target: "_blank", rel: "noopener", href: l.href }, l.label));
    const ok = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "Got it");
    const c = callout({
      id: "phitex-news",
      label: "What's new in the PhiTeX extension",
      anchor: label,
      width: 340,
      header: [h("span", { "aria-hidden": "true" }, "✨"), `What's new in PhiTeX ${items[0].version}`],
      // (an item's few inline tags as elements: rich)
      body: [
        ...items.map((n) => html`<div class="phitex-news-entry"><div class="phitex-news-title">${n.title} <span class="text-muted small">${n.version} · ${n.date}</span></div><ul>${n.items.map((i) => html`<li>${rich(i)}</li>`)}</ul></div>`),
        html`<div class="small text-muted">From the unofficial PhiTeX extension, not Overleaf.</div>`,
      ],
      actions: [...links, ok],
    });
    ok.onclick = () => {
      c.hide();
      label.classList.remove("phitex-dot-new");
      void chrome.storage.local.set({ newsSeen: current });
      // (then the controls the notes are about, pointed at: every one when asked for, else those not seen)
      if (mode === "phitex") setTimeout(() => void featureTips(force), 400);
    };
  }

  /**
   * Feature tips: Overleaf's popover pointing at one of our controls, saying
   * what it does, each once (tipsSeen); What's new shows them all again.
   */
  // (a body: text with a few inline tags (rich), or a function making its markup, a demo in it)
  const TIPS: { id: string; at: () => Element | null; title: string; body: string | (() => Node); isNew?: boolean }[] = [
    { id: "changes", at: () => document.getElementById("phitex-changes"), isNew: true, title: "Changes", body: () => html`Click <b>± Changes</b> to see what changed since any version in the project's history, marked on the page, or switch to <b>Blame</b> to see who wrote each line, from Overleaf's own history. Click it again to close it.<div class="phitex-cmp-demo" aria-hidden="true">The results are <span class="del">good</span><span class="add">&nbsp;excellent</span>.<span class="ver"><i class="v0">Submitted v1</i><i class="v1">Submitted v1 → Your edits now</i></span><span class="tag">‹ 1 / 1 ›</span></div>` },
    { id: "timing", at: () => document.getElementById("phitex-status"), title: "How long it took", body: "The last build, and how long a keystroke takes to reach the page. Click it for the details." },
    { id: "clean", at: () => document.getElementById("phitex-clean"), title: "Clean rebuild", body: "Builds already run as you type. This one reads the project again and typesets it from the start." },
    { id: "dark", at: () => document.querySelector("#toolbar-pdf-controls .theme-toggle-btn"), title: "Dark PDF", body: "Overleaf's dark PDF switch darkens ⚡ Instant's pages too. Off by default: it inverts figures and photos as well." },
  ];
  async function featureTips(all = false, k = 0): Promise<void> {
    document.getElementById("phitex-feature")?.remove();
    document.querySelectorAll(".phitex-ring").forEach((e) => e.classList.remove("phitex-ring"));
    if (mode !== "phitex" || document.getElementById("phitex-tour") || document.getElementById("phitex-tip")) return;
    const { tipsSeen } = await chrome.storage.local.get("tipsSeen");
    const seen = new Set<string>(all ? [] : ((tipsSeen as string[] | undefined) ?? []));
    const left = TIPS.filter((t) => !seen.has(t.id) && t.at());
    const tip = left[k];
    if (!tip) return;
    const target = tip.at()!;
    target.classList.add("phitex-ring");
    const button = (t: string, cls: string, label: string) => h("button", { type: "button", class: `btn ${cls} btn-sm`, "data-t": t }, label);
    const { el } = callout({
      id: "phitex-feature",
      label: tip.title,
      anchor: target,
      header: [...(tip.isNew ? [h("span", { class: "badge bg-primary" }, "New")] : []), h("span", {}, tip.title), h("span", { class: "phitex-callout-step" }, `${k + 1} of ${left.length}`)],
      body: [typeof tip.body === "string" ? rich(tip.body) : tip.body()],
      actions: [button("skip", "btn-link phitex-callout-never", "Skip"), button("next", "btn-primary", k === left.length - 1 ? "Got it" : "Next")],
    });
    // (seen once shown: a tip never comes back by itself)
    void chrome.storage.local.set({ tipsSeen: [...new Set([...((tipsSeen as string[] | undefined) ?? []), tip.id])] });
    // (the control it points at used: the tip has done its work and goes)
    target.addEventListener("click", () => (document.getElementById("phitex-feature")?.remove(), target.classList.remove("phitex-ring")), { capture: true, once: true });
    el.onclick = async (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (!a) return;
      document.getElementById("phitex-feature")?.remove();
      target.classList.remove("phitex-ring");
      if (a === "skip") return void chrome.storage.local.set({ tipsSeen: TIPS.map((t) => t.id) });
      if (all) return void featureTips(true, k + 1);
      void featureTips(false, 0);
    };
  }

  /** The walkthrough: Overleaf's popover, a step at a time, the thing it explains ringed. */
  /** The highlight step's choice: the "follow" setting's values, the first recommended. */
  const FOLLOW: [string, string][] = [["cursor", "Cursor"], ["select", "Selection"], ["dblclick", "Double-click only"]];
  // (a mini editor line, its caret going word to word, and a mini page whose same word turns yellow in step)
  // (each choice its own: Cursor the caret walking, Selection a range selected, Double-click a click on the page sending the editor there)
  const highlightDemo = () => html`<div class="phitex-hl-demo" data-mode="cursor" aria-hidden="true">
      <div class="phitex-hl-ed"><span class="e1">Instant</span> <span class="e2">typing</span> <span class="e3">here</span><i class="phitex-hl-caret"></i></div>
      <div class="phitex-hl-page"><span class="w1">Instant</span> <span class="w2">typing</span> <span class="w3">here</span><i class="phitex-hl-click">⇱</i></div></div>`;
  const STEPS: { at: () => Element | null; title: string; body: string | (() => Node); inside?: boolean; choice?: boolean }[] = [
    { at: () => document.getElementById("phitex-switch"), title: "Two previews, one click", body: "<b>PDF</b> is Overleaf's compiler, as always. <b>⚡ Instant</b> is added by the unofficial PhiTeX extension (not part of Overleaf), live. Switch any time, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>." },
    { at: () => document.querySelector("phitex-preview"), inside: true, title: "Type, and watch", body: "Edit anything in the editor: this page repaints as you type, usually in a few milliseconds. The status in the toolbar says how fast. No Recompile." },
    { at: () => document.querySelector("phitex-preview"), inside: true, choice: true, title: "The yellow highlight", body: () => html`Where you are in the source is marked on the page in yellow.${highlightDemo()}When should it move?` },
    { at: () => document.getElementById("phitex-logs"), title: "What PhiTeX couldn't read", body: "Diagnostics, with a count. Click one to jump to its line. Errors from the build, missing packages, and what LaTeX looked for and did not find." },
    { at: () => document.getElementById("phitex-dlgroup"), title: "Download what you see", body: "This downloads the <b>⚡ Instant</b> PDF (<code>…-instant.pdf</code>). The <b>▾</b> menu has Overleaf's compiled PDF too." },
    { at: () => document.getElementById("phitex-zoom"), title: "Zoom, and the details", body: "Zoom like Overleaf's viewer. At the bottom of this menu: settings and timings (main file, a debug check against a fresh build). Everything runs in your browser; nothing leaves it." },
  ];

  async function tour(k = 0): Promise<void> {
    endTour();
    if (mode !== "phitex") {
      await set("phitex");
      if (viewNow() !== "phitex") return;
    }
    const step = STEPS[k];
    const target = step?.at();
    if (!step || !target) return endTour(true);
    target.classList.add("phitex-ring");
    const button = (t: string, cls: string, label: string) => h("button", { type: "button", class: `btn ${cls} btn-sm`, "data-t": t }, label);
    const { el: t } = callout({
      id: "phitex-tour",
      label: `Tour, step ${k + 1} of ${STEPS.length}`,
      anchor: target,
      inside: step.inside,
      header: [h("span", {}, step.title), h("span", { class: "phitex-callout-step" }, `${k + 1} of ${STEPS.length}`)],
      body: [
        typeof step.body === "string" ? rich(step.body) : step.body(),
        html`<div class="phitex-dots">${STEPS.map((_, i) => html`<span class="${i === k ? "on" : ""}"></span>`)}</div>`,
        step.choice ? html`<div class="phitex-choice" role="radiogroup" aria-label="When the highlight moves">${FOLLOW.map(([v, l], i) => html`<button type="button" role="radio" class="btn btn-secondary btn-sm" data-f="${v}">${l}${i ? "" : html` <small>(recommended)</small>`}</button>`)}</div>` : "",
      ],
      actions: [
        button("skip", "btn-link phitex-callout-never", "Skip"),
        ...(k ? [button("back", "btn-secondary", "Back")] : []),
        button("next", "btn-primary", k === STEPS.length - 1 ? "Done" : "Next"),
      ],
    });
    // (the highlight step: a choice picked is saved and shown in the demo; Next goes on)
    const pick = (f: string) => {
      t.querySelectorAll<HTMLElement>("[data-f]").forEach((b) => {
        const on = b.dataset.f === f;
        b.classList.toggle("btn-primary", on);
        b.classList.toggle("btn-secondary", !on);
        b.setAttribute("aria-checked", String(on));
      });
      t.querySelector<HTMLElement>(".phitex-hl-demo")?.setAttribute("data-mode", f);
    };
    if (step.choice) void chrome.storage.local.get("follow").then(({ follow }) => pick(FOLLOW.some(([v]) => v === follow) ? (follow as string) : FOLLOW[0][0]));
    t.onclick = (e) => {
      const f = (e.target as HTMLElement).closest<HTMLElement>("[data-f]")?.dataset.f;
      if (f) return void (pick(f), chrome.storage.local.set({ follow: f }));
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-t]")?.dataset.t;
      if (a === "next") void tour(k + 1);
      if (a === "back") void tour(k - 1);
      if (a === "skip") endTour(true);
    };
    t.querySelector<HTMLElement>('[data-t="next"], [data-f]')!.focus();
  }

  function endTour(done = false): void {
    document.getElementById("phitex-tour")?.remove();
    document.querySelectorAll(".phitex-ring").forEach((e) => e.classList.remove("phitex-ring"));
    if (done) void chrome.storage.local.set({ toured: true });
  }
  addEventListener("keydown", (e) => e.key === "Escape" && document.getElementById("phitex-tour") && endTour(true));
  // (Ctrl/⌘+S or Ctrl/⌘+Enter, a writer's habit, in ⚡ Instant: a note that there is
  // nothing to do; once in a while, not each press; Overleaf's own keys as they were)
  let habitSaid = -Infinity;
  addEventListener(
    "keydown",
    (e) => {
      if (mode !== "phitex" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !(e.key === "s" || e.key === "S" || e.key === "Enter")) return;
      if (performance.now() - habitSaid < 10_000) return;
      habitSaid = performance.now();
      panel.msg("No need to save or compile: ⚡ Instant typesets as you type, and Overleaf saves by itself.", false, true);
    },
    true,
  );

  /** The left side's width as laid out in full: its first shown child to its last, the status text uncut. */
  function leftSpan(left: Element): number {
    // (#phitex-left's own controls by their own boxes: squeezed, its box is narrower than they are, and they spill over the right side)
    const kids = [...left.children, ...(document.getElementById("phitex-left")?.children ?? [])].filter((e) => (e as HTMLElement).offsetWidth).map((e) => e.getBoundingClientRect());
    const st = document.getElementById("phitex-status");
    // (the status by what a build's status needs, "Built · 9,999 ms", never by the words it says now: what gives way
    // stays put while builds come fast. Its slot's spare room given up first; short of that, the others give way)
    const cut = st?.offsetWidth ? statusNeed(st) - st.clientWidth : 0;
    return kids.length ? Math.max(...kids.map((r) => r.right)) - Math.min(...kids.map((r) => r.left)) + cut + 8 : 0;
  }
  /**
   * The width the status needs: one width whatever the builds do, the
   * widest of what a build's status says ("Built" or "First page", at the
   * worst time of each unit: "· 999 ms", "· 99.9 s", "· 99 min"), in its
   * own fonts; its time alone when bare. Never by the words it says now or
   * the last build's kind: a first page over a second, then builds of a
   * few ms, moved what gives way and everything after it (a runner's
   * fonts, nightly 45005369645). Its box held at least that wide
   * (min-width), so nothing after it moves as its words change; said on
   * it (data-need) for the toolbar's checks.
   */
  let statusNeeds: [number, number] = [0, 0];
  let statusFont = "";
  let measure: CanvasRenderingContext2D | null = null;
  function statusNeed(st: HTMLElement): number {
    const word = st.querySelector<HTMLElement>(".phitex-st-text"), time = st.querySelector<HTMLElement>(".phitex-st-more");
    measure ??= document.createElement("canvas").getContext("2d");
    if (!measure || !word || !time) return 120;
    const font = (e: HTMLElement) => {
      const c = getComputedStyle(e);
      return `${c.fontStyle} ${c.fontWeight} ${c.fontSize} ${c.fontFamily}`;
    };
    const fw = font(word), ft = font(time);
    // (measured again only when its fonts change: Overleaf's theme or zoom)
    if (fw + ft !== statusFont) {
      statusFont = fw + ft;
      measure.font = fw;
      const w = Math.max(...["Built", "First page"].map((l) => measure!.measureText(l).width));
      measure.font = ft;
      const tw = Math.max(...["· 999 ms", "· 99.9 s", "· 99 min"].map((t) => measure!.measureText(t).width));
      statusNeeds = [Math.ceil(w + tw + 4 + 16), Math.ceil(tw + 16)];
    }
    const need = statusNeeds[st.closest(".bare") ? 1 : 0];
    if (st.dataset.need !== String(need)) (st.dataset.need = String(need)), (st.style.minWidth = `${need}px`);
    return need;
  }
  /** The right side's: its first shown button to its last. */
  function rightSpan(right: Element): number {
    const shown = [...right.querySelectorAll("button")].filter((b) => b.offsetWidth).map((b) => b.getBoundingClientRect());
    return shown.length ? Math.max(...shown.map((r) => r.right)) - Math.min(...shown.map((r) => r.left)) : 0;
  }
  let swFull = 149, swNarrow = 89;
  /** ± Changes' word's width, measured while shown. */
  let chgWord = 60;
  /** The status's words' width ("Built"), measured while shown. */
  let statusWord = 40, statusAll = 120, zoomW = 60, leanW = 50;
  /** What the toolbar needs in full, in each mode (0 until it has shown). */
  const needs = { pdf: 0, phitex: 0 };

  function tick(): void {
    // (a hidden tab: nothing to place; the next visible tick does it)
    if (document.hidden) return;
    const pane = document.querySelector<HTMLElement>(PANE);
    const left = pane?.querySelector(".toolbar-pdf-left");
    let right = pane?.querySelector(".toolbar-pdf-right");
    // (a detached tab Overleaf thinks orphaned has no right side: ours, then)
    if (pane && left && !right) {
      right = document.createElement("div");
      right.className = "toolbar-pdf-right";
      left.parentElement!.append(right);
    }
    if (!pane || !left || !right) {
      // (Overleaf renders its layout late: wait for it before falling back to the window)
      if (performance.now() - started < FALLBACK_AFTER_MS) return;
      if (mirrored || DETACHED || detacher()) return panel.shown(false);
      panel.dock(null);
      panel.shown(true);
      document.getElementById("phitex-tip")?.remove();
      return;
    }
    const sw = switchEl(left);
    place(left, sw, leftEl(left));
    // (Overleaf's Recompile, in ⚡ Instant: our clean recompile too, the
    // button the writer already reaches for; Overleaf still compiles its own)
    const rc = left.querySelector<HTMLButtonElement>(".compile-button-group button");
    if (rc && !rc.dataset.phitex) {
      rc.dataset.phitex = "1";
      rc.addEventListener("click", () => mode === "phitex" && panel.clean(), true);
    }
    // (its menu's "Recompile from scratch": ⚡ Instant's from scratch too; told by
    // being the plain item right after a divider, the labels being translated)
    const scratch = [...left.querySelectorAll<HTMLElement>(".compile-button-group .dropdown-menu .dropdown-item")].find((b) => !b.querySelector("input, .material-symbols") && b.closest("li")?.previousElementSibling?.matches('[role="separator"]'));
    if (scratch && !scratch.dataset.phitex) {
      scratch.dataset.phitex = "1";
      scratch.addEventListener("click", () => mode === "phitex" && panel.clean(), true);
    }
    if (rc) rc.title = mode === "phitex" ? "Recompile: Overleaf's PDF, and ⚡ Instant from scratch (PhiTeX)" : (rc.title.startsWith("Recompile: Overleaf") ? "" : rc.title);
    // (compact when the full controls do not fit what the toolbar has left: measured here,
    // not taken from Overleaf's own choice, which counts our switch against its room.
    // What the right side needs in full is measured while it is in full: everything
    // the right side holds, from its first shown button to its last (Overleaf's invert
    // button, the gaps, our settings), and some air)
    const ctl = controlsEl(right);
    const bar = pane.querySelector<HTMLElement>(".toolbar-pdf") ?? pane;
    // (measured, decided, and measured again until nothing more gives way, all in this one pass: what a
    // step frees is only known once it is taken (± Changes' word, the clean rebuild's room), and one
    // step a tick took three ticks, 1.4 s, to settle once the toolbar was drawn; a first page that came
    // within them saw the toolbar move under it (status-steady on the runner, nightly 45010729081))
    for (let pass = 0, was = ""; pass < 4; pass++) {
      if (mode === "phitex") {
        if (!ctl.classList.contains("compact") && ctl.offsetWidth) fullRight = rightSpan(right) + 16;
        ctl.classList.toggle("compact", bar.clientWidth - leftSpan(left) < fullRight);
      }
      // (then, if the bar still has no room: the switch says "PDF | ⚡", back in full once the
      // room it takes is there again. Decided on the wider of the two modes' needs, each
      // measured while it shows, so flipping the switch never changes its width too)
      if (sw.classList.contains("narrow")) swNarrow = sw.offsetWidth || swNarrow;
      else swFull = sw.offsetWidth || swFull;
      // (then ± Changes without its word; then the status its time alone ("· 97 ms"), the clean rebuild and the
      // download's ▾ left to Recompile's menu and the download; then no status at all, never one cut short. Each
      // step's room measured while it shows; every step decided on what the bar needs with all of them undone)
      const lf = document.getElementById("phitex-left"), chg = document.getElementById("phitex-changes");
      const ours = lf && chg && mode === "phitex";
      if (ours) {
        const word = chg.querySelector<HTMLElement>(".button-content");
        const st = document.getElementById("phitex-status");
        if (!lf.classList.contains("tight") && word?.offsetWidth) chgWord = word.offsetWidth + 5;
        const lean = [document.getElementById("phitex-clean"), document.getElementById("phitex-dlmore")];
        if (!lf.classList.contains("lean") && lean.every((e) => e?.offsetWidth)) leanW = lean.reduce((n, e) => n + e!.offsetWidth, 0);
        // (the status's steps by what a build's status needs, not by what it says now)
        if (st && statusNeed(st)) (statusWord = statusNeeds[0] - statusNeeds[1]), (statusAll = statusNeeds[1]);
        const z = document.getElementById("phitex-zoom");
        if (!ctl.classList.contains("nozoom") && z?.offsetWidth) zoomW = z.offsetWidth + 4;
      }
      const given = ours ? (lf.classList.contains("lean") ? leanW : 0) + (lf.classList.contains("tight") ? chgWord : 0) + (lf.classList.contains("bare") ? statusWord : 0) + (lf.classList.contains("gone") ? statusAll : 0) + (ctl.classList.contains("nozoom") ? zoomW : 0) : 0;
      needs[mode] = leftSpan(left) + rightSpan(right) + 16 + (sw.classList.contains("narrow") ? swFull - swNarrow : 0) + given;
      sw.classList.toggle("narrow", Math.max(needs.pdf, needs.phitex) > bar.clientWidth);
      if (ours) {
        const need = needs[mode] - (sw.classList.contains("narrow") ? swFull - swNarrow : 0);
        // (first what has a menu of its own: the clean rebuild (Recompile's) and the download's ▾ (its button);
        // then ± Changes' word; then the status's words, then the status; and last the zoom's level (⋯ zooms))
        let over = need;
        const step = (el: Element, cls: string, saves: number) => (el.classList.toggle(cls, over > bar.clientWidth), (over -= saves));
        step(lf, "lean", leanW);
        step(lf, "tight", chgWord);
        step(lf, "bare", statusWord);
        step(lf, "gone", statusAll);
        step(ctl, "nozoom", zoomW);
        // (the local mock only: each change of what gave way, with what decided it, for the toolbar's checks)
        if (location.hostname === "localhost") {
          const k = `${lf.className}|${ctl.className}|${sw.className}`;
          const g = globalThis as { __phitexBar?: { k: string; log: string[] } };
          g.__phitexBar ??= { k: "", log: [] };
          if (g.__phitexBar.k !== k) {
            g.__phitexBar.k = k;
            g.__phitexBar.log.push(`${Math.round(performance.now())} ms ${lf.className} | need ${Math.round(need)} bar ${bar.clientWidth} left ${Math.round(leftSpan(left))} right ${Math.round(rightSpan(right))} given ${Math.round(given)} | lean ${leanW} word ${chgWord} status ${statusNeeds.join("/")} ${statusFont} | st ${document.getElementById("phitex-status")?.clientWidth} ${document.getElementById("phitex-status")?.style.minWidth}`);
          }
        }
      }
      const now = `${document.getElementById("phitex-left")?.className}|${ctl.className}|${sw.className}`;
      if (now === was) break;
      was = now;
    }
    (sw.querySelector(`input[value="${mode}"]`) as HTMLInputElement).checked = true;
    if (newsPending) {
      sw.querySelector('label[for="phitex-v-phitex"]')?.classList.add("phitex-dot-new");
      // (a moment after the switch appears, and not over the welcome tip)
      if (performance.now() - loadedAt > 2500 && !document.getElementById("phitex-tip")) {
        newsPending = false;
        void whatsNew();
      }
    }
    // (the feature tips not seen yet: once a load, in ⚡ Instant, after the news and any tour or tip)
    if (!tipsTried && !newsPending && mode === "phitex" && performance.now() - loadedAt > 4000) {
      tipsTried = true;
      void chrome.storage.local.get("toured").then(({ toured }) => toured && featureTips());
    }
    panel.dock(pane, pane.querySelector(".toolbar-pdf"));
    pane.classList.toggle("phitex-on", mode === "phitex");
    if (document.body.classList.contains("phitex-on-page") !== (mode === "phitex")) document.body.classList.toggle("phitex-on-page", mode === "phitex");
    panel.shown(mode === "phitex");
  }
  let tipsTried = false;
  let timer = setInterval(tick, 700);
  // (Overleaf draws its PDF toolbar again (its dark-PDF switch, a resize):
  // our switch and controls put back before the next paint, not at the
  // next tick, which left the toolbar without them for up to 0.7 s; only
  // when one is gone, so the editor's own changes cost two lookups)
  const back = new MutationObserver(() => {
    const gone = !document.getElementById("phitex-switch") || (mode === "phitex" && !document.getElementById("phitex-controls"));
    if (gone && document.querySelector(PANE)?.querySelector(".toolbar-pdf-left")) tick();
  });
  back.observe(document.body, { childList: true, subtree: true });
  /** The extension turned off: everything we added goes; Overleaf is as it was. */
  function stop(): void {
    clearInterval(timer);
    back.disconnect();
    endTour();
    hideTip();
    for (const id of ["phitex-switch", "phitex-controls", "phitex-left", "phitex-news", "phitex-consent"]) document.getElementById(id)?.remove();
    document.querySelector(".phitex-on")?.classList.remove("phitex-on");
    document.body.classList.remove("phitex-on-page");
    panel.shown(false);
  }
  chrome.storage.onChanged.addListener((c) => {
    // (a reset removes the keys: newValue undefined is the default)
    if (c.view && (c.view.newValue ?? "pdf") !== mode) void set(c.view.newValue === "phitex" ? "phitex" : "pdf");
    if (c.tipOff) {
      tipOff = !!c.tipOff.newValue;
      if (tipOff) hideTip();
    }
    if (c.accepted) {
      accepted = c.accepted.newValue === TERMS;
      if (!accepted && mode === "phitex") void set("pdf");
    }
  });
  return {
    stop,
    resume: () => {
      clearInterval(timer);
      timer = setInterval(tick, 700);
      back.observe(document.body, { childList: true, subtree: true });
      tick();
    },
    news: () => void whatsNew(true),
    tour: () => void tour(0),
    toggle: () => {
      if (!document.getElementById("phitex-switch")) return false;
      void set(mode === "pdf" ? "phitex" : "pdf");
      return true;
    },
  };
}

/** Only Overleaf's editor (/project/<24 hex id>), not its other pages under /project/; on the local mock, its editor (/project/mock), not its dashboard. */
const EDITOR = /^\/project\/[0-9a-f]{24}(\/detache[dr])?\/?$/;
const MOCK_EDITOR = /^\/project\/mock(\/detache[dr])?\/?$/;

(async () => {
  if (!EDITOR.test(location.pathname) && !(location.hostname === "localhost" && MOCK_EDITOR.test(location.pathname))) return;
  let session: PreviewSession;
  let dock: Dock | undefined;
  /** The compare (diffui.ts, compare.ts): its own session, the marked-up document's; set once the session is. */
  let compare: Compare<Version> | undefined;
  /** The session the panel shows: the compare's while its diff is in view. */
  const shown = () => compare?.shown() ?? session;
  const ch = channel(project());
  /** The project's history, read as asked and kept by project; its reads stopped when the project is left. */
  const history = new ProjectHistory(project, pageFetch, {
    get: async (k) => (await chrome.storage.local.get(k))[k],
    set: (k, v) => chrome.storage.local.set({ [k]: v }),
  });
  addEventListener("pagehide", () => history.abort.abort());
  // (nothing read before ± Changes asks: the visit noted once the history's first page is read for it)
  const noteVisit = () => void (history.latest ? visits.seen(project().replace(/.*\//, ""), history.latest) : undefined);
  const olHistory = overleafHistory({
    history,
    // (the editor's own text and pages, whatever the panel shows (Diff's pages, Changes on): Blame marks those)
    text: (file) => session?.text(file),
    main: () => session?.main ?? null,
    names: () => Object.keys(session?.texts() ?? {}),
    glyphs: (k) => session?.pageGlyphs(k) ?? Promise.resolve([]),
    goto: (file, line) => (DETACHED ? ask({ t: "goto", file, line }) : window.postMessage({ src: "phitex-content", type: "goto", file, line }, location.origin)),
    own: document.querySelector<HTMLMetaElement>('meta[name="ol-user_id"]')?.content || undefined,
    lastVisit: () => visits.prev,
  });
  // (the mock's checks: blame worked out as a scenario asks, its truth beside it; never on overleaf.com)
  if (location.hostname === "localhost") (globalThis as Record<string, unknown>).__phitexHistory = olHistory;
  const ask = (a: Ask) => ch.postMessage(a);
  /** The pages as strips over the core's transport (set once the transport is). */
  let pages: StripPages | undefined;
  /** The packs kept in this browser, emptied by the service worker (asked first): its error, if any. */
  const clearCache = async (): Promise<string | void> => {
    if (!confirm("Clear the LaTeX packages ⚡ Instant keeps in this browser? They are fetched again when a document needs them.")) return;
    const r = await chrome.runtime.sendMessage({ type: "clear-cache" }).catch((e: unknown) => ({ error: String(e) }));
    panel.msg(r?.error ? `Couldn't clear the cache: ${r.error}` : `Cleared ${Math.round((r?.freed ?? 0) / 1048576)} MB of packages.`, !!r?.error, true);
    return r?.error;
  };
  const panel = new Panel({
    onFind: (q) => pages?.find(q) ?? Promise.resolve([]),
    onPage: (p) => (DETACHED ? ask({ t: "page", k: p }) : shown()?.setPage(p)),
    onNeed: (k) => (DETACHED ? ask({ t: "need", k }) : shown()?.fetch(k)),
    onPdf: async () => {
      const pdf = await session?.pdf();
      // (a job that stopped, at a fatal error or a missing file, left pdfTeX's file
      // unfinished: no xref, no trailer, which no viewer opens; said, not saved)
      const tail = pdf && new TextDecoder("latin1").decode(pdf.subarray(Math.max(0, pdf.length - 64)));
      // (no build yet: where the start is, or why it stopped; never "the build stopped", there was none)
      if (!boot.built) {
        panel.msg(boot.errors.length ? `No PDF: ${boot.stage}` : `No PDF yet: no build has run. ⚡ Instant is at "${boot.stage}".`, true);
        return;
      }
      if (!pdf || !pdf.length || !tail!.includes("%%EOF")) {
        panel.msg("No complete PDF yet: the build stopped before the end of the document (see ⓘ diagnostics). Fix that, or download Overleaf's compiled PDF from the ▾ menu.", true);
        return;
      }
      // (a XeLaTeX project approximated: asked again, the file named so)
      if (panel.approx && !confirm("This PDF is an approximation: the project needs XeLaTeX, and ⚡ Instant made it with pdfLaTeX, its fonts substituted and its layout possibly different from Overleaf's.\n\nFor the real PDF, use Overleaf's (the PDF tab).\n\nDownload the approximation anyway?")) return;
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(session.main ?? "phitex").replace(/\.tex$/, "").replace(/.*\//, "")}${panel.approx ? "-approx" : ""}-instant.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    onDebug: (on) => session && (session.debug = on),
    // (the main file picked in the settings: kept for this project, used at its next open)
    onMain: (m) => {
      void chrome.storage.local.get("mains").then(({ mains }) => chrome.storage.local.set({ mains: { ...(mains as Record<string, string> | undefined), [project()]: m } }));
      // (the file built kept, "Yes, build it": only remembered)
      if (m !== session?.main) void session?.setMain(m);
    },
    // (Ctrl+click or a middle click on a link: the project in a tab of its own, its preview
    // at the link's target. The project's editor, not Overleaf's detached PDF page: opening
    // that one makes Overleaf take the PDF out of this tab, and this preview with it)
    onOpenAt: (k, top) => void window.open(`${project()}#at=${k + 1},${Math.round(top ?? 0)}`, "_blank"),
    // (the hook moves the editor's cursor there: the one thing it writes)
    onGoto: (file, line) => DETACHED ? ask({ t: "goto", file, line }) : window.postMessage({ src: "phitex-content", type: "goto", file, line }, location.origin),
    onSyncSource: (k, x, y) => (DETACHED ? ask({ t: "sync", k, x, y }) : void shown()?.toSource(k, x, y)),
    // (the editor tab's panel does it; a detached tab's, told the same, does not)
    // (the card's choice: this project's engine from now on, kept by project)
    onEngine: async (e) => {
      const { engines } = await chrome.storage.local.get("engines");
      await chrome.storage.local.set({ engines: { ...(engines ?? {}), [project()]: e } });
    },
    // (the anonymized debug report: report.ts, shown before it is sent)
    onReport: async () => {
      const m = chrome.runtime.getManifest();
      // (no session yet (the engine didn't start, the project wasn't read): the start's own lines)
      const start = [...(await bootLines()).map((l) => l.replace(/; main file .*$/, "")), await machineLine()].join("\n") + "\n";
      // (no build yet: the start's lines first, its steps and why it stopped, then the session's, whose trace has them too)
      const own = session?.report({ version: m.version, engine: m.version_name?.match(/engine ([0-9a-f]+)/)?.[1] ?? "?", userAgent: navigator.userAgent });
      return own === undefined ? start : boot.built ? own : `${start}\n${own}`;
    },
    // (Copy debug info: the extension, where the start is, its errors; the panel adds the build's and the machine's)
    onDebugInfo: async () => bootLines(),
    onGotoRange: (file, from, to, focus) => DETACHED || window.postMessage({ src: "phitex-content", type: "gotoRange", file, from, to, focus }, location.origin),
    onSelectPage: (sel) => (DETACHED ? undefined : void shown()?.selectPage(sel)),
    onReload: async () => session?.refresh(await fetchDocs(panel)),
    onClean: async () => session?.clean(await fetchDocs(panel)),
    onShortcut: () => dock?.toggle() ?? false,
    onTour: () => dock?.tour(),
    onNews: () => dock?.news(),
    // (the contents opened: the outline of the session shown, asked for now)
    onContents: () => void shown()?.outline(),
    // (the packs kept in this browser: the extension's store, emptied by the service worker)
    onClearCache: () => void clearCache(),
    // (a project file's text as the session has it, for Copy for an AI assistant)
    onSource: async (file) => shown()?.text(file) ?? null,
    // (Settings: the extension's rows, in chrome.storage as the popup keeps them)
    settings: () => overleafSettings(),
    // (the panel's own choices: chrome.storage, the same in every Overleaf tab)
    onPref: async (key, value) => {
      const { viewPrefs } = await chrome.storage.local.get("viewPrefs");
      await chrome.storage.local.set({ viewPrefs: { ...(viewPrefs as Partial<ViewPrefs> | undefined), [key]: value } });
    },
    // (the last build's log: the core's transcript)
    onLog: () => shown()?.log() ?? Promise.resolve(null),
    onBoxes: (file, start, end) => shown()?.boxesOf(file, start, end) ?? Promise.resolve([]),
  }, prefs, {
    host: "overleaf",
    fileUrl: (p) => chrome.runtime.getURL(p),
    // (Changes and Blame: the project's history, exact to the character (olhistory.ts, blame.ts here),
    // the pages' places from the session's glyphs; the diff compare.ts's, its button Overleaf's toolbar's)
    blame: olHistory.blame,
    changes: {
      ...olHistory.changes,
      diff: diffRunner,
      log: async (skip: number, limit: number) => {
        const r = await olHistory.changes.log(skip, limit);
        if (!skip) noteVisit();
        return r;
      },
    },
    ownChangesButton: true,
  });
  if (location.hostname === "localhost") (globalThis as Record<string, unknown>).__phitexPanel = panel;
  // ("Report this" (report.ts) wherever the panel shows an error or the debug info: the card a start
  // that failed leaves, the timings' popover (Copy debug info), and Report a problem's dialog, each
  // given its row as it appears; the panel draws them again, the row is put back)
  {
    const root = (panel as unknown as { root: ShadowRoot }).root;
    const debugText = async () => [...(await bootLines()), await machineLine()].join("\n") + "\n";
    const add = () => {
      const card = root.querySelector<HTMLElement>("#empty:not([hidden]) .card");
      if (card && /Couldn't open/.test(card.querySelector("h3")?.textContent ?? "") && !card.querySelector(".phx-report")) card.append(reportRow(debugText));
      const time = root.querySelector<HTMLElement>("#m-time:not([hidden])");
      if (time?.querySelector(".copydbg") && !time.querySelector(".phx-report")) time.append(reportRow(debugText));
      const dialog = root.querySelector<HTMLElement>("#report:not([hidden])");
      const text = root.querySelector<HTMLTextAreaElement>("#reporttext");
      if (dialog && text && !dialog.querySelector(".phx-report")) text.after(reportRow(async () => text.value));
    };
    new MutationObserver(add).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  }
  // (a tab opened at a place (a link Ctrl+clicked in another): its pages start there, lit once shown)
  {
    const at = /^#at=(\d+),(\d+)$/.exec(location.hash);
    if (at) panel.startAt(Number(at[1]) - 1, Number(at[2]));
  }
  void chrome.storage.local.get("viewPrefs").then(({ viewPrefs }) => panel.viewPrefs((viewPrefs as Partial<ViewPrefs> | undefined) ?? {}));
  /** The extension's rows of the Settings dialog: what the popup sets, kept where it keeps them. */
  async function overleafSettings(): Promise<SettingsGroup[]> {
    const s = await chrome.storage.local.get(["enabled", "view", "engine", "follow", "othersOff", "tipOff", "newsOff", "foldersTipOff", "folders", "statusColumn", "hideData", "accepted"]);
    const c = (await chrome.runtime.sendMessage({ type: "cache-stats" }).catch(() => null)) as { packs: number; bytes: number; capMB: number; ahead: boolean; error?: string } | null;
    const put = (o: Record<string, unknown>) => chrome.storage.local.set(o).then(() => undefined, (e: unknown) => String(e));
    const ask = (m: object) => chrome.runtime.sendMessage(m).then((r: { error?: string } | undefined) => r?.error, (e: unknown) => String(e));
    const toggle = (id: string, label: string, help: string, on: boolean, set: (on: boolean) => Promise<string | void>): SettingRow => ({ id, label, help, kind: "toggle", value: on, set: (v) => set(v === true) });
    const mb = (b: number) => (b < 10 * 1048576 ? (b / 1048576).toFixed(1) : String(Math.round(b / 1048576)));
    const accepted = s.accepted === TERMS;
    return [
      {
        title: "Preview",
        rows: [
          { id: "o-view", label: "Opens with", help: "What Overleaf's PDF pane shows when a project opens", kind: "choice", options: [["pdf", "PDF"], ["phitex", "⚡ Instant"]], value: s.view === "phitex" ? "phitex" : "pdf", set: (v) => put({ view: v }) },
          { id: "follow", label: "Highlight follows", help: "In yellow: the word you're at as the cursor moves, what you select, or a double-click alone", kind: "choice", options: [["cursor", "Cursor"], ["selection", "Selection"], ["dblclick", "Double-click"]], value: (s.follow as string | undefined) ?? "cursor", set: (v) => put({ follow: v }) },
          toggle("o-others", "Collaborators on the PDF", "Where each collaborator is, in their colour; the page never moves for them", !s.othersOff, (on) => put({ othersOff: !on })),
        ],
      },
      {
        title: "Project",
        rows: [
          { id: "o-engine", label: "Engine", help: "Auto: what the project's preamble needs (a project given its own keeps it). LuaLaTeX: coming", kind: "choice", options: [["auto", "Auto"], ...Object.entries(ENGINES).filter(([, e]) => e.ready).map(([v, e]) => [v, e.label] as [string, string])], value: usable((s.engine as string | undefined) ?? "auto"), set: (v) => put({ engine: v }) },
        ],
      },
      { title: "Builds", rows: [{ id: "o-clean", label: "Clean rebuild", help: "Read the project again and typeset it from the start", kind: "action", button: "Rebuild", set: () => (void panel.settings(false), panel.clean()) }] },
      {
        title: "Packages",
        rows: c && !c.error
          ? [
              { id: "o-cache", label: "Packages kept in this browser", help: c.packs ? `${c.packs} packs, ${mb(c.bytes)} of ${mb(c.capMB * 1048576)} MB · fetched once, reused offline` : "Empty: packages are fetched as documents need them", kind: "action", button: "Clear", disabled: c.packs ? undefined : "Empty: packages are fetched as documents need them", set: () => clearCache() },
              { id: "o-cap", label: "Keep at most", help: "Past it, the least recently used go first", kind: "choice", options: [["100", "100 MB"], ["300", "300 MB"], ["1000", "1 GB"]], value: String(c.capMB), set: (v) => ask({ type: "cache-cap", mb: Number(v) }) },
              toggle("o-ahead", "Fetch common packages ahead", "The ones most arXiv papers use, in the background: a first open needs no wait", c.ahead, (on) => ask({ type: "cache-ahead", on })),
            ]
          : [{ id: "o-cache", label: "Packages kept in this browser", kind: "info", value: "", disabled: `Couldn't read them: ${c?.error ?? "the extension did not answer"}` }],
      },
      {
        title: "Updates and tips",
        rows: [
          toggle("o-tip", "Show the ⚡ Instant tip", "On Overleaf's PDF, until turned off", !s.tipOff, (on) => put({ tipOff: !on })),
          toggle("o-foldertip", "Show the folders tip", "On the project dashboard, until you have a folder", !s.foldersTipOff, (on) => put({ foldersTipOff: !on })),
          toggle("o-news", "Show what's new after updates", "Once per version, over the pages", !s.newsOff, (on) => put({ newsOff: !on })),
        ],
      },
      {
        title: "Overleaf",
        rows: [
          toggle("o-enabled", "Enable on Overleaf", "Off: Overleaf exactly as it is, ⚡ Instant and folders gone", s.enabled !== false, (on) => put({ enabled: on })),
          toggle("o-folders", "Folders", "Nested folders for your projects on the dashboard, kept in your Overleaf project .phitex-data", s.folders !== false, (on) => put({ folders: on })),
          { ...toggle("o-status", "Status column", "Each project's status (idea, drafting, submitted, …), and sorting by it", s.statusColumn === true, (on) => put({ statusColumn: on })), disabled: s.folders === false ? "With folders on" : undefined },
          { ...toggle("o-hide", "Hide .phitex-data", "Leave the folders' own project out of your project list", s.hideData === true, (on) => put({ hideData: on })), disabled: s.folders === false ? "With folders on" : undefined },
          { id: "o-withdraw", label: "Terms", help: accepted ? "Accepted: unofficial, experimental, as is, no warranty, at your own risk" : "Not accepted yet", kind: "action", button: "Withdraw consent", disabled: accepted ? undefined : "Not accepted yet", set: () => put({ accepted: 0, view: "pdf" }) },
          { id: "o-reset", label: "Reset extension", help: "Every setting as just installed; your Overleaf projects untouched", kind: "action", button: "Reset", set: () => (confirm("Reset ⚡ Instant's settings to how they were when installed?") ? resetAll().then(() => undefined, (e: unknown) => String(e)) : undefined) },
        ],
      },
    ];
  }
  // (off in the popup: nothing at all, not even the project fetched; on again, live)
  let { enabled } = await chrome.storage.local.get("enabled");
  let started = false;
  const start = async () => {
    started = true;
    dock = dockInOverleaf(panel);
    await go();
  };

  /**
   * A compare (diffui.ts's runner, compare.ts): the version's files from
   * Overleaf's history, the marked-up document's session on a port of its
   * own, its binary files the project's as last read.
   */
  function compareWith(host: OverleafHost, core: FrameTransport, opts: ConstructorParameters<typeof PreviewSession>[3]): Compare<Version> {
    return new Compare<Version>({
      session: () => session,
      core,
      onChanges: (cb) => host.onChanges(cb),
      async files(v, say) {
        say(`Fetching version ${v.v}…`);
        return (await filesAt(project(), v.v, pageFetch)).files;
      },
      async connect() {
        const t = new FrameTransport(false);
        await t.connect();
        for (const [p, b] of Object.entries(lastBinaries)) await t.request({ op: "binary", file: p, bytes: b } as never);
        // (the diff's pages as strips too, composed here)
        return new StripPages(t, panel, panel.stripsChip());
      },
      sink: (on) => gate(tee(panel, mirrorOut(ch), () => mirrored), on, ["goto"]),
      goto: (file, from, to) => window.postMessage({ src: "phitex-content", type: "gotoRange", file, from, to, focus: false }, location.origin),
      save(bytes, type, name) {
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      },
      msg: (t) => panel.msg(t, true),
      options: opts ?? {},
    });
  }
  chrome.storage.onChanged.addListener((c) => {
    if (c.enabled) {
      enabled = c.enabled.newValue;
      if (enabled === false) {
        dock?.stop();
        session?.pause(true);
      } else if (!started) void start();
      else {
        dock?.resume();
        session?.pause(false);
      }
    }
    if (c.panel) {
      if (!c.panel.newValue) panel.zoomTo("fit");
    }
  });
  chrome.runtime.onMessage.addListener((m, _from, reply) => {
    if (m?.type === "phitex-tour") dock?.tour();
    if (m?.type === "phitex-news") dock?.news();
    // (the toolbar popup's Copy debug info: this tab's, whatever state it is in)
    if (m?.type === "phitex-debug-info") {
      void Promise.all([bootLines(), machineLine()]).then(([l, m]) => reply([...l, m].join("\n") + "\n"));
      return true;
    }
  });
  /** The session: the core connected, the project loaded, closed docs followed. */
  async function go(): Promise<void> {
  if (DETACHED) {
    // (the start is the editor tab's, told here as it goes, and when this tab says hello: until then, waiting for it)
    boot.head = boot.stage = "Waiting for the editor tab…";
    boot.whose = "the editor tab";
    bootShown();
    ch.addEventListener("message", (e: MessageEvent<BootTold>) => void (e.data?.t === "boot" && bootHeard(e.data)));
    // (its pages drawn here, at this tab's zoom, from the editor tab's core's strips)
    const own = new StripPages(remoteCore(ch), panel, panel.stripsChip());
    pages = own;
    (globalThis as any).__phitexPages = own; // (tests, devtools)
    // (Overleaf's ← here: the place on these pages found in the source by the editor tab's session, as a double-click here is)
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.src !== "phitex-hook" || e.data.type !== "toCode") return;
      const p = panel.spot();
      if (p) ask({ t: "sync", k: p.k, x: p.x, y: p.y });
    });
    return follow(ch, panel, (k) => own.request({ op: "png", page: k }));
  }
  // (the start, told to a detached tab as it goes: its status and debug info are this one's)
  bootOut = (b) => ch.postMessage(b);
  // (the detached tab's asks; what the session tells the panel goes there too)
  ch.addEventListener("message", (e: MessageEvent<Ask>) => {
    const a = e.data;
    if (a.t === "hello") {
      mirrored = true;
      // (the start as it is, for the detached tab's status and debug info)
      ch.postMessage(bootTold());
      // (the hook's: Overleaf's → beside the editor goes to the detached tab's ⚡ pages, not its hidden PDF)
      document.body.classList.add("phitex-mirrored");
      void session?.resync();
    }
    if (a.t === "bye") (mirrored = false), document.body.classList.remove("phitex-mirrored");
    if (a.t === "need") void session?.fetch(a.k);
    if (a.t === "page") void session?.setPage(a.k);
    if (a.t === "sync") void session?.toSource(a.k, a.x, a.y);
    if (a.t === "goto") window.postMessage({ src: "phitex-content", type: "goto", file: a.file, line: a.line }, location.origin);
    if (a.t === "core") void answer(ch, a, pages);
  });
  // (when the page highlights the editor's place: "cursor" as it moves,
  // "select" what is selected, "dblclick" only on a double-click; the popup's)
  let highlightMode = "select";
  // (the default: the highlight follows where you type)
  void chrome.storage.local.get("follow").then(({ follow: f }) => (highlightMode = (f as string | undefined) ?? "cursor"));
  // (collaborators' cursors on the pages, each in their colour, never moving
  // the view: on unless the popup's switch turned them off)
  let othersOn = true;
  let others: { file: string; others: { label: string; hue: number; pos: number }[] } | null = null;
  void chrome.storage.local.get("othersOff").then(({ othersOff }) => (othersOn = !othersOff));
  chrome.storage.onChanged.addListener((c) => {
    if (c.follow) highlightMode = (c.follow.newValue as string | undefined) ?? "cursor";
    if (c.othersOff) {
      othersOn = !c.othersOff.newValue;
      if (others) session?.others(others.file, othersOn ? others.others : []);
    }
  });
  /**
   * A binary file uploaded or replaced (hook.ts): its new bytes given to the
   * core, and a build that reads every file again. Its path is by its name in
   * `/entities`; two files of that name: both read again, from the ZIP, which
   * has them all.
   */
  const replaced = async (id: string, name: string) => {
    if (!giveBinary) return;
    const r = await pageFetch(`${project()}/entities`, { credentials: "include" });
    if (!r.ok) return;
    const { entities } = (await r.json()) as { entities: { path: string; type: string }[] };
    const paths = entities.filter((e) => e.type === "file" && e.path.split("/").pop() === name).map((e) => e.path.replace(/^\//, ""));
    if (paths.length === 1) {
      const f = await pageFetch(`${project()}/file/${id}`, { credentials: "include" });
      if (!f.ok) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      lastBinaries[paths[0]] = bytes;
      await giveBinary(paths[0], bytes);
    } else {
      const z = await pageFetch(`${project()}/download/zip`, { credentials: "include" });
      if (!z.ok) return;
      const { binaries } = await readZip(await z.arrayBuffer(), () => {});
      for (const p of paths) {
        if (!binaries[p]) continue;
        lastBinaries[p] = binaries[p];
        await giveBinary(p, binaries[p]);
      }
    }
    // (those files read again, nothing else checked)
    await transport.request({ op: "changed", files: paths.filter((p) => p in lastBinaries) } as never);
  };
  // Overleaf's main document (the project's root doc, the hook's `rootDoc`):
  // the session's main unless one was picked in the settings (kept by
  // project), as its Recompile builds it. Asked once now: the hook may have
  // heard the socket's join before this script listened.
  let overleafRoot: string | null = null;
  // (the settings' list of main files told anew: set once the session's sink is made)
  let resyncMains = () => {};
  const followRoot = async () => {
    if (!session?.main || !overleafRoot || overleafRoot === session.main || session.text(overleafRoot) === undefined) return;
    const picked = ((await chrome.storage.local.get("mains")).mains as Record<string, string> | undefined)?.[project()];
    if (picked && session.text(picked) !== undefined) return;
    await session.setMain(overleafRoot);
    resyncMains();
  };
  window.postMessage({ src: "phitex-content", type: "rootDoc?" }, location.origin);
  // (a double-click in the editor or on the file outline: that place on the page)
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-hook") return;
    if (e.data.type === "sync") void session?.toPage(e.data.file, e.data.pos);
    if (e.data.type === "fileReplaced") void replaced(String(e.data.id), String(e.data.name));
    // (Overleaf's main document, as its socket told the hook: followed unless one was picked here)
    if (e.data.type === "rootDoc") {
      overleafRoot = typeof e.data.path === "string" ? e.data.path : null;
      void followRoot();
    }
    // (Overleaf's ← beside the PDF: the place on the ⚡ pages in the editor)
    if (e.data.type === "toCode") {
      const p = panel.spot();
      if (p) void session?.toSource(p.k, p.x, p.y);
    }
    // (the editor's cursor as it moves: the word it is in, on the page)
    // (while a compare's diff is shown, on its pages, through the diff's map)
    if (e.data.type === "cursor" && highlightMode === "cursor") (compare ?? session)?.follow(e.data.file, e.data.pos);
    // (collaborators' cursors in the open file: their words marked in their colours)
    if (e.data.type === "others") {
      others = { file: e.data.file, others: e.data.others };
      if (othersOn) session?.others(e.data.file, e.data.others);
    }
    // (the editor's selection: its text highlighted on the pages)
    if (e.data.type === "select" && (highlightMode !== "dblclick" || e.data.from === e.data.to)) void session?.selectSource(e.data.file, e.data.from, e.data.to);
  });
  const transport = new FrameTransport();
  // (the pages as strips: the core draws them, this tab composes them; MuPDF
  // can't run here, overleaf.com's policy forbids the tab WebAssembly)
  // (a detached tab draws its own pages from this core's strips: this tab's
  // own, its panel off screen, drawn small, not at the zoom over again)
  const offScreen = () => mirrored && !document.querySelector("phitex-preview")?.checkVisibility();
  // (a scenario's slow first build, on the local mock only: the project's open held till the page calls
  // phitexReleaseBuild(): its files known, no page drawn, as a long first build is on a big project)
  if (testFailure() === "build-hold") {
    const request = transport.request.bind(transport);
    let held: (() => void)[] | null = [];
    window.addEventListener("message", (e) => e.data?.src === "phitex-dev" && e.data.type === "release-build" && (held?.forEach((f) => f()), (held = null)));
    transport.request = ((op: { op: string }) => (op.op === "open" && held ? new Promise((ok) => held!.push(() => ok(request(op as never)))) : request(op as never))) as typeof transport.request;
  }
  pages = new StripPages(
    transport,
    {
      pixelsPerPoint: () => (offScreen() ? 0.25 : panel.pixelsPerPoint()),
      pageView: (k) => (offScreen() ? null : panel.pageView(k)),
      painted: (ms) => panel.painted(ms),
    },
    panel.stripsChip(),
  );
  // (Shelf's release, release.ts: an extension older than it needs asks for
  // an update, and its notice shows; both once per page, and it keeps working)
  let releaseShown = false;
  // (the core's worker's own words, its failures: in the dev trace, and
  // its errors (what the engine wrote to stderr, why it stopped) in this
  // tab's console, where a report reads them)
  transport.onEvent((e) => {
    const c = e as unknown as { event: string; item?: { kind?: string; text?: string } };
    if (c.event !== "console") return;
    devMark(`core: ${c.item?.text}`);
    if (c.item?.kind === "error") console.warn("[phitex core]", c.item.text);
  });
  transport.onEvent((e) => {
    if (e.event !== "release" || !e.release || releaseShown) return;
    const min = e.release.min_extension;
    const lines: Node[] = [];
    if (min && older(chrome.runtime.getManifest().version, min))
      lines.push(html`A newer PhiTeX Instant is out (${min}): this one keeps working, but update it for the latest packages and fixes. In Chrome: chrome://extensions → <b>Update</b>.`);
    if (e.release.notice) lines.push(document.createTextNode(e.release.notice));
    if (!lines.length) return;
    releaseShown = true;
    if (lines.length && min && older(chrome.runtime.getManifest().version, min)) void chrome.runtime.sendMessage({ type: "update-check" }).catch(() => undefined);
    const t = document.createElement("div");
    t.className = "popover bs-popover-top show phitex-toast";
    t.setAttribute("role", "status");
    t.replaceChildren(html`<div class="popover-body">⚡ ${lines.map((l, i) => (i ? [h("br"), l] : l))}</div>`);
    Object.assign(t.style, { position: "fixed", right: "16px", bottom: "16px", maxWidth: "340px", zIndex: "1060" });
    document.body.append(t);
    t.onclick = () => t.remove();
  });
  // (the core gone (a trap, out of memory, its worker dead): the session
  // asks at once, so the reason is said now (and it reopens, or stops on a
  // document too large), not at whatever request came next)
  transport.onEvent((e) => void ((e as { event?: string }).event === "trapped" && session?.resync()));
  // (and before a build: the start stopped there, with why, for the status text and Copy debug info)
  transport.onEvent((e) => void ((e as { event?: string }).event === "trapped" && !boot.built && !boot.failed && bootFailed(new Error((e as { error?: string }).error ?? "the engine stopped"))));
  transport.onGone(() => {
    const t = document.createElement("div");
    t.className = "popover bs-popover-top show phitex-toast";
    t.setAttribute("role", "status");
    t.replaceChildren(html`<div class="popover-body">⚡ ${GONE}. <button type="button" class="btn btn-primary btn-sm">Reload</button></div>`);
    Object.assign(t.style, { position: "fixed", right: "16px", bottom: "16px", maxWidth: "340px", zIndex: "1060" });
    document.body.append(t);
    t.querySelector("button")!.onclick = () => location.reload();
  });
  try {
    devMark("connect");
    if (contextGone()) return;
    reading(panel, { h: "Starting the engine…" });
    await transport.connect((step) => reading(panel, { h: "Starting the engine…", detail: step }));
    devMark("connected");
    // (a figure the engine didn't take: the read stops there, saying so, not a build missing it)
    const given = (what: string) => (r: CoreRes) => {
      if (!r.ok) throw new Error(`${what}: ${(r as { error?: string }).error ?? "the engine refused it"}`);
      return r;
    };
    giveBinary = (path, bytes) => transport.request({ op: "binary", file: path, bytes } as never).then(given(`giving a file of ${mb(bytes.length)} to the engine`));
    takeBinary = (path) => transport.request({ op: "withdraw", file: path } as never).then(given("taking a file back from the engine"));
    let engineSetting: EngineChoice = "auto", projectEngine: Engine | undefined;
    const readEngine = async () => {
      const { engine, engines } = await chrome.storage.local.get(["engine", "engines"]);
      engineSetting = usable((engine as string | undefined) ?? "auto");
      projectEngine = (engines as Record<string, Engine> | undefined)?.[project()];
    };
    await readEngine();
    // (the engine, set for every project or for this one: typeset again with it)
    chrome.storage.onChanged.addListener(async (c) => {
      if (!c.engine && !c.engines) return;
      await readEngine();
      session.clean(await fetchDocs(panel));
    });
    const host = new OverleafHost(panel);
    const opts: ConstructorParameters<typeof PreviewSession>[3] = {
      engine: (main) => resolve(engineSetting, projectEngine, main),
      // (a XeLaTeX project: approximated with pdfLaTeX, unless chosen for it)
      shims: async (main) => (projectEngine || !approximable(main) ? null : shimTexts((p) => platform().asset(p))),
    };
    const sink = gate(tee(panel, mirrorOut(ch), () => mirrored), () => compare?.showing !== "diff");
    session = new PreviewSession(host, pages, sink, {
      ...opts,
      // (a double-click's source, and text selected on the pages: bytes of
      // the file as the session has it, the editor put there; a selection
      // leaves the focus on the pages)
      remote: {
        source: (file, start, end) => sourceAt(file, start, end, true),
        select: (file, start, end) => sourceAt(file, start, end, false),
      },
    });
    const sourceAt = (file: string, start: number, end: number, focus: boolean) => {
      const t = session.text(file);
      if (t !== undefined) window.postMessage({ src: "phitex-content", type: "gotoRange", file, from: charOffset(t, start), to: charOffset(t, end), focus }, location.origin);
    };
    (globalThis as any).__phitexSession = session; // (tests, devtools)
    // (a build in: its fetch round closed, as a build request's answer closes
    // it; the session's remote mode has none, so the last pack fetched
    // would stay "loading"; and the build's own times in the trace)
    transport.onEvent((e) => {
      if (e.event !== "settled") return;
      if (!boot.built) {
        boot.steps.push({ h: "Built", t: performance.now() - boot.t0, far: "" });
        boot.built = true;
        bootShown();
      }
      session.tr("settled", e);
      void (session as unknown as { core: CoreTransport }).core.request({ op: "status" });
    });
    // (a compare's session: the marked-up document opened as a project of its own)
    compare = compareWith(host, transport, opts);
    if (location.hostname === "localhost") (globalThis as Record<string, unknown>).__phitexCompare = compare;
    // (Changes' versions are the history's, `v42`: version 42's files)
    diffImpl = compare.runner((id) => ({ v: Number(id.replace(/^v/, "").replace(/~.*/, "")), title: id, at: 0, who: [], label: false }));
    devMark("start");
    bootTrace = (k, d) => session.tr(k, d);
    // (the project read, its figures given to the core as they come; then
    // opened: the core builds it and says when its pages are in. Overleaf
    // not handing it over (a 500 while it saves a burst of edits, the
    // network): the start waits for Overleaf, and goes on at the next edit,
    // the tab shown again, the network back, or Try again; never stopped
    // until a reload)
    let files: Record<string, string>;
    for (;;) {
      try {
        files = await host.loadProject();
        break;
      } catch (e) {
        if (!(e instanceof NotHanded)) throw e;
        // (kept in the errors and the trace; the start is waiting, not stopped)
        bootFailed(e);
        boot.failed = false;
        boot.head = "Waiting for Overleaf…";
        boot.stage = e.plain;
        bootShown();
        await new Promise<void>((on) => {
          let done = false;
          const vis = () => void (document.hidden || again());
          const again = () => {
            if (done) return;
            done = true;
            document.removeEventListener("visibilitychange", vis);
            removeEventListener("online", again);
            on();
          };
          host.onChanges(() => again());
          document.addEventListener("visibilitychange", vis);
          addEventListener("online", again);
          panel.error(e.plain, { title: "Waiting for Overleaf", note: "PhiTeX opens the project at your next edit, or when you come back to this tab.", again });
        });
      }
    }
    session.refresh(files);
    // (the main file picked for this project, else the guess: never the file open for being open)
    // (then Overleaf's own main document, its Menu's, when the hook heard it already: else it follows when heard, followRoot)
    const picked = ((await chrome.storage.local.get("mains")).mains as Record<string, string> | undefined)?.[project()];
    const main = picked && picked in files ? picked : overleafRoot && overleafRoot in files ? overleafRoot : guessMain(files);
    boot.read.main = main ?? "";
    reading(panel, { h: "Opening the main file (the first build)…", detail: main ?? undefined });
    // (no main file chosen for this project yet: the panel asks which it is, the pick above preselected)
    sink.mains?.(Object.keys(files).filter((f) => f.endsWith(".tex")), main, !(picked && picked in files));
    resyncMains = () => sink.mains?.(Object.keys(files).filter((f) => f.endsWith(".tex")), session.main);
    if (!main) throw new Error("no main .tex file found");
    await session.setMain(main);
    // (Overleaf's main document heard while the project was read, after the guess above: followed now)
    void followRoot();
    // (the editor's open file announced again: its text, unsaved edits and all, wins over the ZIP's)
    host.ready();
    devMark("started");
    ch.postMessage({ t: "up" });
    // (closed docs: fetched again and diffed in, so collaborators' edits to
    // them arrive as edits; the open one is live through the editor)
    setInterval(async () => {
      if (document.hidden || enabled === false) return;
      try {
        session.refresh(await fetchDocs(panel, (p) => p !== session.open));
      } catch {
        /* (offline: next time) */
      }
    }, FOLLOW_MS);
  } catch (e) {
    // (the step it stopped at, and why: the card, the status, the title, Copy debug info)
    panel.error(bootFailed(e));
  }
  }

  if (enabled === false) return;
  await start();
})();

