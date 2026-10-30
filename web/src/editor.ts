// The editor: CodeMirror 6 with Overleaf's LaTeX grammar, as the mock's
// (mock/editor/editor.mjs; the grammar generated into web/build/ by
// scripts/build-web.sh). One file at a time; its edits told as the session
// takes them, in the order applied (overleaf/src/hook.ts's), and its
// cursor, selection and double-clicks, for the pages to follow.

import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
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

// (Overleaf's light theme's colours, roughly; the dark ones for a dark page)
const light = HighlightStyle.define([
  { tag: t.tagName, color: "#7b2bb3" },
  { tag: t.comment, color: "#6c7380", fontStyle: "italic" },
  { tag: t.string, color: "#0a6b3d" },
  { tag: t.keyword, color: "#1b4bb3" },
  { tag: t.number, color: "#a35100" },
]);

export interface EditorEvents {
  /** `file`'s edits, and its length after them (UTF-16 units). */
  changed(file: string, edits: Edit[], len: number): void;
  /** The cursor moved (no selection). */
  cursor(file: string, pos: number): void;
  /** Text selected ([from, to), from < to). */
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
      syntaxHighlighting(light),
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
      if (r.empty) this.ev.cursor(this.file, r.head);
      else this.ev.selected(this.file, r.from, r.to);
    }
  }

  /** `file` shown with `text` (no edit told). */
  show(file: string, text: string): void {
    this.file = file;
    this.quiet = true;
    this.view.setState(EditorState.create({ doc: text, extensions: this.extensions() }));
    this.quiet = false;
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
