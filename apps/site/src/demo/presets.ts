// The demo's example projects: plain TeX in the subset PhiTeX reads today.
import book from "../content/book.tex?raw";

export interface Preset {
  id: string;
  label: string;
  blurb: string;
  main: string;
  /** The file shown in the editor. */
  open: string;
  files: Record<string, string>;
}

const article = String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage[margin=1in]{geometry}

\title{Type here.}
\author{A. Writer}

\begin{document}
\maketitle

\section{Instant}
Everything on the page to the right is set by \textbf{PhiTeX} as you
type. Change a word: the paragraph you touched is built again, and the
page is repainted before you lift your finger. Nothing is uploaded.

\section{Exact}\label{exact}
The instant result is \emph{always} the same PDF a full build would
make. References settle on their own: this is Section~\ref{exact}, and
the claim is due to Knuth~\cite{knuth84}.

\section{Private}
Your document never leaves your computer. There is no server to send it
to.

\end{document}
`;

const plain = String.raw`\font\rm=Times-Roman at 11pt
\font\bf=Times-Bold at 11pt
\font\it=Times-Italic at 11pt
\font\big=Times-Bold at 26pt
\font\tt=Courier at 10pt
\rm

\centerline{\big Type here.}
\vskip 18pt

Everything on the page to the right is set by {\bf PhiTeX}, a TeX
engine compiled to WebAssembly and running in this tab. Change a word:
the paragraph you touched is built again, and the page is repainted.
Nothing is sent anywhere.

PhiTeX turns your document into a {\it program in SSA form}. Every
value (a macro, a register, a paragraph) is defined once, and every use
points at the one value it means. An edit rebuilds only the chunks it
touched, and the chunks that read what they changed.

\def\PhiTeX{{\bf Phi}{\it TeX}}
Macros are values too: \PhiTeX\ here is a use of the {\tt\string\def}
above. Change its body, and every paragraph that uses it is rebuilt,
and nothing else.

\count1=0
\def\loop{\ifnum\count1<3 \advance\count1 by 1 \loop\fi}
\loop
A loop ran \the\count1\ times; its arms meet in $\phi$ nodes.

\bye
`;

const bookMain = String.raw`\input book

\begindocument
\section{Why incremental}\label{why}
A document is edited far more often than it is written. PhiTeX keeps
it compiled while you type: each paragraph is a chunk of SSA, and an
edit rebuilds only the chunks it touched.\index{chunks}
Section~\ref{loop} explains the fixed point.

PhiTeX also paginates: the output routine runs as a chunk of its own,
kept when its page is the same.\footnote{Running heads come from
\string\mark, page numbers from \string\count0.}\index{pages}

\section{The fixed point}\label{loop}
References go through the {\it .aux} file, as in TeX: this
section is number~\ref{loop}, on page~\pageref{loop}, and
Section~\ref{why} is on page~\pageref{why}.\index{aux file}
Rename a label, or move a section: the loop runs again until nothing
changes, and the result equals a fresh build.

The index below is made the same way, through the {\it .idx} and
{\it .ind} files.\index{index}

\printindex
\enddocument
`;

const para = (i: number) =>
  `Paragraph ${i} has words enough to take a line or two of the page it is on, and a few more.\n\n`;
const stress =
  "% 2000 paragraphs, 38 pages. Edit anywhere: one chunk is rebuilt.\n\n" +
  Array.from({ length: 2000 }, (_, i) => para(i + 1)).join("") +
  "\\bye\n";

export const PRESETS: Preset[] = [
  { id: "article", label: "LaTeX article", blurb: "sections, refs, a citation", main: "main.tex", open: "main.tex", files: { "main.tex": article } },
  { id: "plain", label: "Plain TeX", blurb: "fonts, macros, a loop", main: "doc.tex", open: "doc.tex", files: { "doc.tex": plain } },
  {
    id: "book",
    label: "Book",
    blurb: "\\ref, \\pageref, footnotes, an index: the .aux loop",
    main: "main.tex",
    open: "main.tex",
    files: { "main.tex": bookMain, "book.tex": book },
  },
  { id: "stress", label: "Stress · 38 pages", blurb: "2000 paragraphs, 185 KB", main: "doc.tex", open: "doc.tex", files: { "doc.tex": stress } },
];
