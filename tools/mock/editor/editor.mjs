// The mock's editor: CodeMirror 6 as Overleaf runs it (the same packages,
// Overleaf's LaTeX grammar), so the extension's hook meets a real
// EditorView: `.cm-editor .cm-content`, `cmView`/`cmTile`, update(), setState().
import { EditorState, RangeSet, RangeValue, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LRLanguage, LanguageSupport, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { parser } from "../build/latex.mjs";

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
        "EnvName": t.keyword,
      }),
    ],
  }),
});
// (Overleaf's light theme colours, roughly)
const style = HighlightStyle.define([
  { tag: t.tagName, color: "#7b2bb3" },
  { tag: t.comment, color: "#6c7380", fontStyle: "italic" },
  { tag: t.string, color: "#0a6b3d" },
  { tag: t.keyword, color: "#1b4bb3" },
  { tag: t.number, color: "#a35100" },
]);

/**
 * Collaborators' cursors as Overleaf keeps them (its cursor highlights): a
 * field holding a RangeSet of values, each with its `highlight` {label
 * (their name), cursor, hue (their colour)}, at their place, mapped through
 * the text's changes, set anew by an effect as Overleaf's socket tells
 * where each one is; drawn as a bar in their colour. The extension's hook
 * reads them from the editor's state.
 */
export const setCursorHighlights = StateEffect.define();
class CursorHighlight extends RangeValue {
  constructor(highlight) {
    super();
    this.highlight = highlight;
  }
  eq(o) {
    return o.highlight.label === this.highlight.label && o.highlight.hue === this.highlight.hue;
  }
}
class CursorWidget extends WidgetType {
  constructor(h) {
    super();
    this.h = h;
  }
  eq(o) {
    return o.h.label === this.h.label && o.h.hue === this.h.hue;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "ol-cm-cursorHighlight";
    s.style.cssText = `border-left:2px solid hsl(${this.h.hue},70%,40%);margin-left:-1px`;
    s.title = this.h.label;
    return s;
  }
}
const cursorHighlights = StateField.define({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setCursorHighlights)) set = RangeSet.of(e.value.map((h) => new CursorHighlight({ label: h.label, cursor: { row: 0, column: 0 }, hue: h.hue }).range(h.pos)), true);
    return set;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (st) => {
      const out = [];
      for (const it = st.field(f).iter(); it.value; it.next()) out.push(Decoration.widget({ widget: new CursorWidget(it.value.highlight), side: 1 }).range(it.from));
      return Decoration.set(out, true);
    }),
});

export { EditorState, EditorView };
export const extensions = (onUpdate) => [
  cursorHighlights,
  lineNumbers(),
  highlightActiveLine(),
  drawSelection(),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  new LanguageSupport(latex),
  syntaxHighlighting(style),
  EditorView.lineWrapping,
  EditorView.updateListener.of(onUpdate),
  EditorView.theme({ "&": { height: "100%", flex: "1" }, ".cm-scroller": { fontFamily: "ui-monospace, monospace", fontSize: "13px" } }),
];
