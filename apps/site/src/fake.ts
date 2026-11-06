// DESIGN PREVIEW ONLY: a toy "typesetter" that turns the presets' plain TeX
// into HTML, so the page's look can be settled before the real PhiTeX core
// (src/vendor/, wasm) is wired in. It is not PhiTeX and claims nothing.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Paragraph blocks, as TeX sees them: split at blank lines. */
export function blocks(src: string): string[] {
  return src.split(/\n[ \t]*\n/);
}

/** The block the offset `at` falls in. */
export function blockAt(src: string, at: number): number {
  const re = /\n[ \t]*\n/g;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && m.index < at) k++;
  return k;
}

interface Ctx {
  sec: number;
  labels: Record<string, number>;
  foot: string[];
}

const DEF = /\\[gex]?def\s*\\[A-Za-z@]+[^{]*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
const LATEX = /\\(documentclass|usepackage)(\[[^\]]*\])?\{[^}]*\}|\\(begin|end)\{document\}|\\(title|author)\{[^}]*\}/g;
const SETUP = /\\(count\d+=\d+|input\s+\S+|loop\b|font\\\w+=\S+(\s+at\s+\S+)?|begindocument|rm\b)/g;

function inline(t: string, c: Ctx): string {
  let s = esc(t.replace(DEF, "").replace(SETUP, "").replace(LATEX, ""));
  s = s.replace(/\\emph\{([^{}]*)\}/g, "<i>$1</i>").replace(/\\textbf\{([^{}]*)\}/g, "<b>$1</b>").replace(/\\textit\{([^{}]*)\}/g, "<i>$1</i>");
  s = s.replace(/\\cite\{[^}]*\}/g, "[1]");
  s = s.replace(/\\string\\([A-Za-z]+)/g, "&#92;$1");
  s = s.replace(/\\label\{([^}]*)\}/g, "").replace(/\\index\{[^}]*\}/g, "");
  s = s.replace(/\\ref\{([^}]*)\}/g, (_, l) => String(c.labels[l] ?? "??"));
  s = s.replace(/\\pageref\{([^}]*)\}/g, (_, l) => (l in c.labels ? "1" : "??"));
  s = s.replace(/\\footnote\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, f) => {
    c.foot.push(f);
    return `<sup>${c.foot.length}</sup>`;
  });
  s = s.replace(/\\PhiTeX\\? ?/g, "<b>Phi</b><i>TeX</i> ");
  s = s.replace(/\\the\\count1\\?/g, "3");
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\{\\bf ([^{}]*)\}/g, "<b>$1</b>");
    s = s.replace(/\{\\it ([^{}]*)\}/g, "<i>$1</i>");
    s = s.replace(/\{\\tt ([^{}]*)\}/g, '<span style="font-family:var(--mono)">$1</span>');
  }
  s = s.replace(/\$([^$]*)\$/g, "<i>$1</i>");
  s = s.replace(/~/g, "&nbsp;");
  s = s.replace(/\\[A-Za-z@]+\s?/g, "").replace(/\\./g, "").replace(/[{}]/g, "");
  return s.trim();
}

/** Only commands (and their arguments), no words: sets things up, prints nothing. */
const silent = (b: string) => !/\\maketitle/.test(b) && !b.replace(/%.*$/gm, "").replace(DEF, "").replace(SETUP, "").replace(LATEX, "").replace(/\\[A-Za-z@]+(=[^\s]*)?(\s+at\s+\S+)?/g, "").replace(/[{}=\d\s.<>pt-]/g, "");

export interface Typeset {
  html: string;
  /** Paragraph blocks, in source order; `chunk` indexes the printed ones. */
  chunks: number;
  pages: number;
}

/** `src` as a page of HTML; each printed block a `.ch` with data-b = its block index. */
export function typeset(src: string, opts: { runhead?: boolean; pages?: number } = {}): Typeset {
  const c: Ctx = { sec: 0, labels: {}, foot: [] };
  // (labels first: \ref may come before its \label, as through the .aux)
  let n = 0;
  for (const m of src.matchAll(/\\section\{[^}]*\}(\\label\{([^}]*)\})?/g)) {
    n++;
    if (m[2]) c.labels[m[2]] = n;
  }
  const bs = blocks(src);
  let html = opts.runhead ? `<div class="runhead">1. ${esc(src.match(/\\section\{([^}]*)\}/)?.[1] ?? "")}</div>` : "";
  let shown = 0;
  bs.forEach((raw, i) => {
    if (shown > 14) return;
    const b = raw.replace(/%.*$/gm, "").trim();
    if (!b || silent(b)) return;
    if (/\\bye|\\enddocument|\\end\{document\}/.test(b) && b.length < 16) return;
    let out = "";
    const center = b.match(/\\centerline\{\\big ([^}]*)\}/);
    if (center) out += `<h1>${inline(center[1], c)}</h1>`;
    if (/\\maketitle/.test(b)) {
      const title = src.match(/\\title\{([^}]*)\}/)?.[1] ?? "";
      const author = src.match(/\\author\{([^}]*)\}/)?.[1] ?? "";
      out += `<h1>${esc(title)}</h1><div class="author">${esc(author)}</div>`;
    }
    let rest = b.replace(/\\maketitle/, "").replace(/\\centerline\{[^}]*\}\}?/, "").replace(/\\vskip\s*\S+/g, "");
    const sec = rest.match(/\\section\{([^}]*)\}/);
    if (sec) {
      c.sec++;
      out += `<h2>${c.sec}. ${inline(sec[1], c)}</h2>`;
      rest = rest.replace(/\\section\{[^}]*\}/, "");
    }
    if (/\\printindex/.test(rest)) {
      c.sec++;
      out += `<h2>${c.sec}. Index</h2><p class="noindent">aux file, 1<br>chunks, 1<br>index, 1<br>pages, 1</p>`;
      rest = rest.replace(/\\printindex/, "");
    }
    const text = inline(rest, c);
    if (text) out += `<p${/\\noindent/.test(rest) ? ' class="noindent"' : ""}>${text}</p>`;
    if (!out) return;
    shown++;
    html += `<div class="ch" data-b="${i}">${out}</div>`;
  });
  if (c.foot.length) html += `<div class="fn">${c.foot.map((f, i) => `<sup>${i + 1}</sup> ${inline(f, c)}`).join("<br>")}</div>`;
  if (opts.runhead) html += `<div class="folio">1</div>`;
  return { html, chunks: bs.length, pages: opts.pages ?? 1 };
}

/** TeX source as highlighted HTML; block `hot` wrapped in .para-hot. */
export function highlight(src: string, hot = -1): string {
  const tok = (s: string) =>
    esc(s).replace(/(%[^\n]*)|(\\(?:[A-Za-z@]+|.))|([{}])|(\$)|(\b\d+(?:pt)?\b)/g, (m, cm, cs, br, ma, nu) =>
      cm ? `<span class="cm">${m}</span>` : cs ? `<span class="cs">${m}</span>` : br ? `<span class="br">${m}</span>` : ma ? `<span class="ma">${m}</span>` : nu ? `<span class="nu">${m}</span>` : m,
    );
  if (hot < 0) return tok(src) + "\n";
  const parts = src.split(/(\n[ \t]*\n)/);
  return parts.map((p, i) => (i === hot * 2 ? `<span class="para-hot">${tok(p)}</span>` : tok(p))).join("") + "\n";
}
