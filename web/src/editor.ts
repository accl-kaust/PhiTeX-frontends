// The editor: CodeMirror 6 with Overleaf's LaTeX grammar, as the mock's
// (mock/editor/editor.mjs; the grammar generated into web/build/ by
// scripts/build/build-web.sh). One file at a time; its edits told as the session
// takes them, in the order applied (overleaf/src/hook.ts's), and its
// cursor, selection and double-clicks, for the pages to follow.

import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, LRLanguage, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { parser } from "../build/latex.mjs";
import type { Edit } from "../../common/src/viewer/edits.ts";

const latex = LRLanguage.define({
  name: "latex",
  parser: parser.configure({
    props: [
      styleTags({
        "CtrlSeq Csname": t.tagName,
        Comment: t.comment,
        "OpenBrace CloseBrace": t.brace,
        "Dollar Math Math/MathChar": t.string,
        "LiteralArgContent VerbContent VerbatimContent LstInlineContent": t.string,
        Number: t.number,
        EnvName: t.keyword,
      }),
    ],
  }),
});

// (Overleaf's light theme's colours, roughly; the dark ones on the app's dark tokens, style.ts)
const light = HighlightStyle.define([
  { tag: t.tagName, color: "#7b2bb3" },
  { tag: t.comment, color: "#6c7380", fontStyle: "italic" },
  { tag: t.string, color: "#0a6b3d" },
  { tag: t.keyword, color: "#1b4bb3" },
  { tag: t.number, color: "#a35100" },
]);
const dark = HighlightStyle.define([
  { tag: t.tagName, color: "#c792ea" },
  { tag: t.comment, color: "#7f8a9c", fontStyle: "italic" },
  { tag: t.string, color: "#8fd19e" },
  { tag: t.keyword, color: "#82aaff" },
  { tag: t.number, color: "#f0a868" },
]);
/** The editor's frame on the app's tokens (style.ts), in either look. */
const frame = {
  "&": { background: "var(--bg)", color: "var(--fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { caretColor: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": { background: "var(--bg2)", color: "var(--fg2)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { background: "color-mix(in srgb, var(--sel) 40%, transparent)" },
  ".cm-activeLineGutter": { background: "var(--hover)", color: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { background: "var(--sel)" },
  "&.cm-focused .cm-matchingBracket": { background: "var(--sel)", outline: "1px solid var(--current)" },
};
/** The look for a light or a dark page: the frame from the app's tokens, the highlighting its own. */
const looks = {
  light: [syntaxHighlighting(light), EditorView.theme(frame, { dark: false })],
  dark: [syntaxHighlighting(dark), EditorView.theme(frame, { dark: true })],
};

export interface EditorEvents {
  /** `file`'s edits, and its length after them (UTF-16 units). */
  changed(file: string, edits: Edit[], len: number): void;
  /** The cursor moved (no selection). */
  cursor(file: string, pos: number): void;
  /** The selection, [from, to) (from === to: none, which clears its marks on the pages), as Overleaf's hook posts it. */
  selected(file: string, from: number, to: number): void;
  /** A double-click at `pos`. */
  dblclick(file: string, pos: number): void;
}

export class Editor {
  private view: EditorView;
  private ev: EditorEvents;
  /** The file shown. */
  file = "";
  /** (a text set by `show` is no edit) */
  private quiet = false;
  /** The look in use, swapped as the page's theme changes (`dark`). */
  private look = new Compartment();
  private isDark = false;

  constructor(parent: HTMLElement, ev: EditorEvents) {
    this.ev = ev;
    this.view = new EditorView({ parent });
    this.view.dom.addEventListener("dblclick", (e) => {
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos !== null) this.ev.dblclick(this.file, pos);
    });
  }

  private extensions(): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      new LanguageSupport(latex),
      this.look.of(looks[this.isDark ? "dark" : "light"]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => this.update(u)),
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "ui-monospace, 'DejaVu Sans Mono', monospace", fontSize: "13px" } }),
    ];
  }

  private update(u: ViewUpdate): void {
    if (this.quiet) return;
    if (u.docChanged)
      for (const tr of u.transactions) {
        if (tr.changes.empty) continue;
        const edits: Edit[] = [];
        // (fromB: where the change is once those before it are applied)
        tr.changes.iterChanges((fromA, toA, fromB, _toB, ins) => edits.push({ from: fromB, to: fromB + (toA - fromA), text: ins.toString() }));
        this.ev.changed(this.file, edits, tr.newDoc.length);
      }
    if (u.selectionSet && u.view.hasFocus) {
      const r = u.state.selection.main;
      this.ev.selected(this.file, r.from, r.to);
      if (r.empty) this.ev.cursor(this.file, r.head);
    }
  }

  /** `file` shown with `text` (no edit told). */
  show(file: string, text: string): void {
    this.file = file;
    this.quiet = true;
    this.view.setState(EditorState.create({ doc: text, extensions: this.extensions() }));
    this.quiet = false;
  }

  /** The page went dark or light: the editor's look with it, now. */
  dark(on: boolean): void {
    this.isDark = on;
    this.view.dispatch({ effects: this.look.reconfigure(looks[on ? "dark" : "light"]) });
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  /** [from, to) selected and scrolled to; `focus`: the keyboard here too. */
  select(from: number, to: number, focus = true): void {
    const n = this.view.state.doc.length;
    const [a, b] = [Math.min(from, n), Math.min(to, n)];
    this.quiet = true;
    this.view.dispatch({ selection: EditorSelection.single(a, b), effects: EditorView.scrollIntoView(a, { y: "center" }) });
    this.quiet = false;
    if (focus) this.view.focus();
  }

  /** Line `line`'s start (1-based). */
  lineStart(line: number): number {
    const d = this.view.state.doc;
    return d.line(Math.max(1, Math.min(line, d.lines))).from;
  }

  destroy(): void {
    this.view.destroy();
  }
}
