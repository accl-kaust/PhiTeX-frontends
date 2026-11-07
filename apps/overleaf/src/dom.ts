// Small DOM pieces, in Overleaf's own classes so its theme styles them: an
// element builder, an icon (Overleaf's Material Symbols font), a dropdown
// menu, a modal, a colour picker, how long ago. The extension's every part
// builds with them: the editor's content script, the dashboard's folders
// (callout.ts, the popovers, too).

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** What a value in an `html` template may be: text (or a number), a node, a list of them, or nothing (null, undefined, false). */
export type Slot = string | number | boolean | Node | null | undefined | readonly Slot[];

const MARK = "phx-slot-";
/** Each template's markup, parsed once (its literal parts only, the values' places marked). */
const parsed = new WeakMap<TemplateStringsArray, DocumentFragment>();

/**
 * Markup from a template's literal parts, which only the code writes: they
 * are parsed (in a <template>, so rows and list items parse anywhere), and
 * each value is put in its place through the DOM, never parsed: text as a
 * text node, a node as itself, a list as its items; in a quoted attribute
 * (`class="a ${x}"`), as the attribute's text, or, the whole of it and true
 * or false (or nothing), the attribute there or not (`disabled="${busy}"`). No value may be an event
 * handler (`on…`). The stores' linters flag HTML assigned from strings; this
 * is the extension's one way to write markup.
 */
export function html(strings: TemplateStringsArray, ...values: Slot[]): DocumentFragment {
  let base = parsed.get(strings);
  if (!base) {
    let src = "";
    strings.forEach((s, i) => {
      src += s;
      if (i === values.length) return;
      // (inside a tag, after an attribute's opening quote: the attribute's text; else a node's place)
      // (raw text: a value inside <style>, <textarea>, <title> or <script> would be its marker's text)
      if (/<(style|textarea|title|script)\b[^>]*>(?![\s\S]*<\/\1>)[\s\S]*$/i.test(src)) throw new Error("html: no value inside <style>, <textarea>, <title> or <script>");
      if (/<[a-zA-Z][^<>]*=\s*"[^"]*$/.test(src)) src += `${MARK}${i}`;
      else if (/<[a-zA-Z][^<>]*$/.test(src)) throw new Error(`html: a value inside a tag must be in a quoted attribute (after ${JSON.stringify(s.slice(-40))})`);
      else src += `<template ${MARK}${i}></template>`;
    });
    base = new DOMParser().parseFromString(`<template>${src}</template>`, "text/html").querySelector("template")!.content;
    // (the template's own line breaks between elements are its layout, not text: dropped, as JSX does)
    const drop = (n: Node) => {
      for (const k of [...n.childNodes]) {
        if (k.nodeType === Node.TEXT_NODE && /^\s*$/.test(k.textContent!) && k.textContent!.includes("\n")) k.remove();
        else drop(k instanceof HTMLTemplateElement ? k.content : k);
      }
    };
    drop(base);
    parsed.set(strings, base);
  }
  // (filled in the parser's own, inert document, then adopted where it is put: no attribute is ever a marker in the page)
  const frag = base.cloneNode(true) as DocumentFragment;
  const nodes = (v: Slot): (Node | string)[] => (v === null || v === undefined || v === false ? [] : Array.isArray(v) ? v.flatMap(nodes) : [v instanceof Node ? v : String(v)]);
  const walk = (root: ParentNode) => {
    for (const el of [...root.querySelectorAll("*")]) {
      if (el.localName === "template" && el.attributes.length === 1 && el.attributes[0].name.startsWith(MARK)) {
        el.replaceWith(...nodes(values[+el.attributes[0].name.slice(MARK.length)]));
        continue;
      }
      for (const a of [...el.attributes]) {
        if (!a.value.includes(MARK)) continue;
        if (a.name.startsWith("on")) throw new Error(`html: no value in an event handler (${a.name})`);
        // (a value that is the whole attribute, true or false: the attribute there or not, disabled="${!ok}";
        // an aria- or data- one says "true" or "false")
        const whole = new RegExp(`^${MARK}(\\d+)$`).exec(a.value), v = whole && values[+whole[1]];
        if (whole && !/^(aria|data)-/.test(a.name) && (v === true || v === false || v === null || v === undefined)) {
          if (v === true) el.setAttribute(a.name, "");
          else el.removeAttribute(a.name);
          continue;
        }
        el.setAttribute(a.name, a.value.replace(new RegExp(`${MARK}(\\d+)`, "g"), (_, n) => nodes(values[+n]).map((x) => (typeof x === "string" ? x : x.textContent)).join("")));
      }
      if (el instanceof HTMLTemplateElement) walk(el.content);
    }
  };
  walk(frag);
  return frag;
}

/** Text with a few inline tags in it (<b>, <code>, <i>, <kbd>; the news' items): those as elements, the rest as text. */
export function rich(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  const open: Node[] = [f];
  for (const part of text.split(/(<\/?(?:b|code|i|kbd)>)/)) {
    const tag = /^<(\/?)(b|code|i|kbd)>$/.exec(part);
    if (!tag) part && open[open.length - 1].appendChild(document.createTextNode(part));
    else if (!tag[1]) open.push(open[open.length - 1].appendChild(document.createElement(tag[2])));
    else if (open.length > 1) open.pop();
  }
  return f;
}

export const icon = (name: string, cls = "") => h("span", { class: `material-symbols ${cls}`, "aria-hidden": "true", translate: "no" }, name);

// (handlers here are block bodies: an on* handler returning false cancels its event)

/** A dropdown menu under `anchor`: its items (null actions left out), "-" a divider. */
export function menu(anchor: HTMLElement, items: ([string | Node, (() => void) | null] | "-")[]) {
  const ul = h("ul", { class: "dropdown-menu dropdown-menu-sm-width show olf-menu", role: "menu" });
  for (const item of items) {
    if (item === "-") {
      ul.append(h("li", {}, h("hr", { class: "dropdown-divider" })));
      continue;
    }
    const [label, act] = item;
    if (!act) continue;
    const b = h("button", { type: "button", class: "dropdown-item", role: "menuitem" }, label);
    b.onclick = () => {
      close();
      act();
    };
    ul.append(h("li", {}, b));
  }
  const r = anchor.getBoundingClientRect();
  Object.assign(ul.style, { position: "fixed", top: `${r.bottom + 2}px`, left: `${r.right}px`, transform: "translateX(-100%)" });
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key === "Escape" : !ul.contains(e.target as Node)) close();
  };
  function close() {
    ul.remove();
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("keydown", away, true);
  }
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", away, true);
  document.body.append(ul);
  (ul.querySelector("button") as HTMLElement | null)?.focus();
}

export type DialogOptions = {
  title: string;
  text?: string;
  /** A text field, with this value. */
  input?: string;
  /** More, under the field (a colour picker, a list). */
  extra?: Node;
  ok: string;
  danger?: boolean;
  cancel?: boolean;
  validate?: (v: string) => string | null;
};

/** A modal: resolves to its input's value, trimmed ("" without one), on OK; null on cancel. */
export function dialog(o: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const input = o.input === undefined ? null : h("input", { class: "form-control", type: "text", "aria-label": "Folder name" });
    if (input) input.value = o.input!;
    const error = h("div", { class: "olf-error small" });
    const ok = h("button", { type: "submit", class: `btn ${o.danger ? "btn-danger" : "btn-primary"}` }, o.ok);
    const cancel = h("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
    const form = h("form", { class: "modal-content" },
      h("div", { class: "modal-header" }, h("h4", { class: "modal-title" }, o.title)),
      h("div", { class: "modal-body" }, ...(o.text ? [h("p", { class: "mb-0" }, o.text)] : []), ...(input ? [input, error] : []), ...(o.extra ? [o.extra] : [])),
      h("div", { class: "modal-footer" }, ...(o.cancel === false ? [] : [cancel]), ok));
    const modal = h("div", { class: "modal fade show d-block project-list-modal olf-modal", role: "dialog", "aria-modal": "true", tabindex: "-1" }, h("div", { class: "modal-dialog" }, form));
    const backdrop = h("div", { class: "modal-backdrop fade show" });
    const check = () => {
      const why = input && o.validate ? o.validate(input.value) : null;
      error.textContent = why ?? "";
      ok.toggleAttribute("disabled", !!why);
      return !why;
    };
    const done = (v: string | null) => {
      modal.remove();
      backdrop.remove();
      document.body.classList.remove("modal-open");
      resolve(v);
    };
    input?.addEventListener("input", check);
    form.onsubmit = (e) => {
      e.preventDefault();
      if (check()) done(input?.value.trim() ?? "");
    };
    cancel.onclick = () => done(null);
    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };
    modal.onkeydown = (e) => {
      if (e.key === "Escape") done(null);
    };
    document.body.append(backdrop, modal);
    document.body.classList.add("modal-open");
    if (input) check(), input.focus(), input.select();
    else ok.focus();
  });
}

/** Overleaf's tag colours (its colour picker's), and one of the user's own. */
export const COLOURS = ["#A7B1C2", "#F04343", "#DD8A3E", "#E4CA3E", "#33CF67", "#43A7F0", "#434AF0", "#B943F0", "#FF4BCD"];

/** A colour picker, as Overleaf's: swatches, and a custom one; `.value` the colour picked. */
export function colourPicker(initial: string): HTMLElement & { value: string } {
  const el = Object.assign(h("div", { class: "olf-colours", role: "radiogroup", "aria-label": "Colour" }), { value: initial });
  const custom = h("input", { type: "color", class: "olf-colour olf-colour-custom", title: "Another colour", "aria-label": "Another colour" });
  const pick = (c: string) => {
    el.value = c;
    for (const b of el.querySelectorAll<HTMLElement>(".olf-colour")) b.classList.toggle("selected", b.dataset.c?.toLowerCase() === c.toLowerCase());
    custom.classList.toggle("selected", !COLOURS.some((x) => x.toLowerCase() === c.toLowerCase()));
  };
  for (const c of COLOURS) {
    const b = h("button", { type: "button", class: "olf-colour", "data-c": c, style: `--c: ${c}`, role: "radio", "aria-label": c });
    b.onclick = () => pick(c);
    el.append(b);
  }
  custom.value = initial.length === 7 ? initial : "#000000";
  custom.oninput = () => pick(custom.value);
  el.append(custom);
  pick(initial);
  return el;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 days ago", as Overleaf's own dates say it (`at`: ISO, or ms since the epoch). */
export function ago(at: string | number): string {
  const s = ((typeof at === "number" ? at : Date.parse(at)) - Date.now()) / 1000;
  for (const [unit, n] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  return rtf.format(0, "second");
}
