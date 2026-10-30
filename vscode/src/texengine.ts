// The TeX engine the builtin engine runs a project with: a `% !TEX program =`
// comment in its main file (as phitex watch honours it), else the setting
// phitex.texEngine, else what its preamble needs (viewer/src/engines.ts:
// fontspec, unicode-math, polyglossia… XeLaTeX), else pdfLaTeX.

import { ENGINES, needs, type Engine } from "../../common/src/viewer/engines.ts";

/** The engine for `main` (the main file's text) under `setting` ("auto", or an engine); `unready`: the one wanted but not runnable yet (LuaLaTeX), pdfLaTeX used instead. */
export function texEngineOf(main: string | undefined, setting = "auto"): { engine: string; unready?: string } {
  const magic = main?.slice(0, 4000).match(/^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([\w-]+)/im)?.[1].toLowerCase();
  const want = magic ?? (setting !== "auto" ? setting : (needs(main) ?? "pdflatex"));
  const known = ENGINES[want as Engine];
  return !known || known.ready ? { engine: want } : { engine: "pdflatex", unready: known.label };
}
