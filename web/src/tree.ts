// The project's files beside the editor: the text files (opened in the
// editor) and the binary ones (figures: listed), the main file marked; add,
// rename, delete and upload, each told to the app.

export interface TreeEvents {
  open(path: string): void;
  add(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  main(path: string): void;
  upload(files: File[]): void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A path the project may hold: relative, no "..", no empty parts. */
export function validPath(p: string): boolean {
  const parts = p.split("/");
  return !!p && !p.startsWith("/") && parts.every((s) => s && s !== "." && s !== "..");
}

export class Tree {
  private el: HTMLElement;
  private ev: TreeEvents;
  private open = "";

  constructor(el: HTMLElement, ev: TreeEvents) {
    this.el = el;
    this.ev = ev;
    el.innerHTML =
      `<div class="phx-tree-head"><span>Files</span><span class="grow"></span>` +
      `<button type="button" data-act="new" title="New file">＋</button>` +
      `<label class="up" title="Upload files (figures, .bib, .tex…)">⇪<input type="file" multiple hidden></label></div>` +
      `<ul class="phx-tree-list" role="tree" aria-label="Project files"></ul>` +
      `<form class="phx-tree-name" hidden><input type="text" spellcheck="false" aria-label="File name"></form>`;
    const input = el.querySelector<HTMLInputElement>("input[type=file]")!;
    input.onchange = () => {
      if (input.files?.length) this.ev.upload([...input.files]);
      input.value = "";
    };
    el.querySelector<HTMLButtonElement>("[data-act=new]")!.onclick = () => this.ask("", (p) => this.ev.add(p));
    el.querySelector<HTMLElement>(".phx-tree-list")!.onclick = (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>("li[data-path]");
      if (!row) return;
      const p = row.dataset.path!;
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "rename") return this.ask(p, (q) => q !== p && this.ev.rename(p, q));
      if (act === "delete") return this.ev.remove(p);
      if (act === "main") return this.ev.main(p);
      if (row.dataset.text) this.ev.open(p);
    };
  }

  /** A name asked for in the field under the list (`start`: its first value), `done` with it if valid. */
  private ask(start: string, done: (p: string) => void): void {
    const form = this.el.querySelector<HTMLFormElement>(".phx-tree-name")!;
    const input = form.querySelector("input")!;
    form.hidden = false;
    input.value = start;
    input.placeholder = "chapter.tex";
    input.focus();
    input.select();
    let ended = false;
    const end = (ok: boolean) => {
      if (ended) return;
      ended = true;
      form.onsubmit = null;
      input.onblur = null;
      input.onkeydown = null;
      form.hidden = true;
      const p = input.value.trim();
      if (ok && validPath(p)) done(p);
    };
    form.onsubmit = (e) => (e.preventDefault(), end(true));
    input.onkeydown = (e) => {
      if (e.key === "Enter") (e.preventDefault(), end(true));
      if (e.key === "Escape") end(false);
    };
    // (leaving the field keeps the name; after the click that left it is done, not in it)
    input.onblur = () => void setTimeout(() => end(true));
  }

  /** The list: text files and binaries, `open` the one in the editor, `main` the one typeset. */
  show(texts: string[], binaries: string[], open: string, main: string): void {
    this.open = open;
    const row = (p: string, text: boolean) =>
      `<li role="treeitem" data-path="${esc(p)}"${text ? ' data-text="1"' : ""} class="${p === this.open ? "on" : ""}${text ? "" : " bin"}" aria-selected="${p === this.open}">` +
      `<span class="name" title="${esc(p)}">${p === main ? "★ " : ""}${esc(p)}</span>` +
      `<span class="acts">${text && p.endsWith(".tex") && p !== main ? `<button type="button" data-act="main" title="Typeset this file">★</button>` : ""}` +
      `<button type="button" data-act="rename" title="Rename">✎</button><button type="button" data-act="delete" title="Delete">✕</button></span></li>`;
    const all = [...texts.map((p) => [p, true] as const), ...binaries.map((p) => [p, false] as const)].sort((a, b) => a[0].localeCompare(b[0]));
    this.el.querySelector(".phx-tree-list")!.innerHTML = all.map(([p, t]) => row(p, t)).join("");
  }
}
