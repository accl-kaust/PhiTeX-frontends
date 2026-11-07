// Projects the dashboard makes: a new one (blank, an example, a ZIP
// uploaded: POST /project/new, /project/new/upload) and a copy (POST
// /project/<id>/clone), seen from their requests in the page's world (fetch,
// and XMLHttpRequest: Overleaf's upload is Uppy's), each with the id the
// answer gives. ui.ts files it where it was made. Overleaf may open the new
// project at once, before the folders are saved: what to file is kept in
// this browser first (pending), and filed at the dashboard's next load too.

/** A request of this extension's own (project.ts: the storage project's upload): never reported. */
export const own = new WeakSet<object>();

const NEW = /^\/project\/new(\/upload)?\/?$/i;
const CLONE = /^\/project\/([0-9a-f]{24})\/clone\/?$/i;

/** Reports each project made: its id, and the project it was copied from (null: a new one). */
export function watchCreated(made: (id: string, from: string | null) => void): () => void {
  const what = (method: string | undefined, url: string | URL): { from: string | null } | null => {
    if ((method ?? "GET").toUpperCase() !== "POST") return null;
    const path = new URL(String(url), location.href).pathname;
    const c = CLONE.exec(path);
    return c ? { from: c[1] } : NEW.test(path) ? { from: null } : null;
  };
  const answered = (text: string, from: string | null) => {
    try {
      const id = JSON.parse(text)?.project_id;
      if (typeof id === "string" && /^[0-9a-f]{24}$/.test(id)) made(id, from);
    } catch {
      // (not JSON: a failure, nothing made)
    }
  };

  const theirFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const p = theirFetch.call(this, input, init);
    const req = input instanceof Request ? input : null;
    const w = init && own.has(init) ? null : what(init?.method ?? req?.method, req ? req.url : (input as string | URL));
    if (w) void p.then((r) => (r.ok ? r.clone().text() : ""), () => "").then((t) => t && answered(t, w.from));
    return p;
  };

  const theirOpen = XMLHttpRequest.prototype.open;
  const theirSend = XMLHttpRequest.prototype.send;
  const asked = new WeakMap<XMLHttpRequest, { from: string | null }>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const w = what(method, url);
    if (w) asked.set(this, w);
    else asked.delete(this);
    return (theirOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const w = asked.get(this);
    if (w) this.addEventListener("load", () => this.status < 300 && (this.responseType === "" || this.responseType === "text") && answered(this.responseText, w.from), { once: true });
    return theirSend.call(this, body);
  };

  return () => {
    window.fetch = theirFetch;
    XMLHttpRequest.prototype.open = theirOpen;
    XMLHttpRequest.prototype.send = theirSend;
  };
}

const KEY = "phitex:folders-pending";

/** Projects to file, by id: their folder, and when (a day old: dropped, its folder long gone or filed). */
type Pending = Record<string, { folder: string; at: number }>;

function read(): Pending {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function write(p: Pending): void {
  try {
    if (Object.keys(p).length) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    // (no storage here: filed now only)
  }
}

/** `id` to be filed in `folder`, kept until filed. */
export function remember(id: string, folder: string): void {
  write({ ...read(), [id]: { folder, at: Date.now() } });
}

/** The projects still to file (those older than a day dropped). */
export function pending(): [string, string][] {
  const day = Date.now() - 864e5;
  return Object.entries(read())
    .filter(([, p]) => p && typeof p.folder === "string" && p.at > day)
    .map(([id, p]) => [id, p.folder]);
}

/** `ids` filed (or never to be): no longer pending. */
export function forget(ids: string[]): void {
  const p = read();
  for (const id of ids) delete p[id];
  write(p);
}
