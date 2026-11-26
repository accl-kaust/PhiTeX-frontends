// The build's problems as marks on Overleaf's editor (hook.ts draws them):
// each error and warning at the command it is about, as the viewer says
// them plainly (its plainDiagnostics: the cause, not TeX's internal macro).

import { plainDiagnostics, type Diagnostic } from "./common/viewer/diagnostics.ts";
import type { PreviewSink, Status } from "./common/viewer/session.ts";

/** A mark: `len` characters at `start` of line `line` of `file`, whose text is `text` (found by it near its line, gone once the line is edited). */
export interface Mark {
  file: string;
  line: number;
  text: string;
  start: number;
  len: number;
  severity: "error" | "warning";
  message: string;
}

type Plain = (ds: readonly Diagnostic[]) => Diagnostic[];

/** The marks of `ds`: errors and warnings whose problem names its command on a line of a file (its excerpt). */
export function marksOf(ds: readonly Diagnostic[], plain: Plain = plainDiagnostics): Mark[] {
  const out: Mark[] = [];
  for (const d of plain(ds)) {
    const p = d.problem;
    const x = p?.excerpt;
    const line = p?.line ?? d.line;
    const file = p?.file ?? d.file;
    if ((d.severity !== "error" && d.severity !== "warning") || !x || !x.len || !line || !file) continue;
    out.push({ file, line, text: x.text, start: x.start, len: x.len, severity: d.severity, message: d.message });
  }
  return out;
}

/** `sink` whose every status also tells the editor's marks (`tell`), when they changed. */
export function withMarks(sink: PreviewSink, tell: (marks: Mark[]) => void): PreviewSink {
  let last = "";
  return new Proxy(sink, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k !== "status" || typeof v !== "function") return v;
      return (s: Status) => {
        const marks = marksOf(s.diagnostics ?? []);
        const key = JSON.stringify(marks);
        if (key !== last) (last = key), tell(marks);
        return v.call(t, s);
      };
    },
  });
}
