// Small DOM pieces, in Overleaf's own classes so its theme styles them: an
// element builder, an icon (Overleaf's Material Symbols font), a dropdown
// menu, a modal.

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
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
/** "3 days ago", as the table's dates. */
export function ago(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  for (const [unit, n] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  return rtf.format(0, "second");
}
