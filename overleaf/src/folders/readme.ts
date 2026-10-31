// The storage project's main.tex: what the project is, for whoever opens it
// (pdfLaTeX, Overleaf's default; a page). Put there when the project's made
// (project.ts): what the project is; and, a page on, how we suggest
// organizing (folders, statuses, tags). A raw string: no backticks or
// dollar-braces in it.

export const README_TEX = String.raw`% This project keeps the folders of PhiTeX Instant, an unofficial browser
% extension for Overleaf. The folders themselves are in data/folders.json.
\documentclass[11pt]{article}
\usepackage[a4paper, margin=0pt]{geometry}
\usepackage[T1]{fontenc}
\usepackage[sfdefault, light]{FiraSans}
\usepackage[scale=0.86]{FiraMono}
\usepackage{fontawesome5}
\usepackage{xcolor}
\usepackage{tikz}
\usetikzlibrary{positioning, calc, arrows.meta, shadows.blur, decorations.pathmorphing}
\usepackage[most]{tcolorbox}
\usepackage{enumitem}
\usepackage{colortbl}
\usepackage{microtype}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0pt}

% Overleaf's own colours
\definecolor{ink}{HTML}{1B222C}
\definecolor{ink2}{HTML}{2F3A4C}
\definecolor{leaf}{HTML}{1D3E72}
\definecolor{leaflight}{HTML}{53B57F}
\definecolor{mist}{HTML}{F4F5F6}
\definecolor{slate}{HTML}{5A6578}
\definecolor{line}{HTML}{DFE3EA}
\definecolor{amber}{HTML}{B9770E}
\definecolor{amberlight}{HTML}{FFF4E0}

\newcommand{\file}[1]{{\ttfamily\color{ink}#1}}
\newcommand{\sep}{{\color{slate}\,\scriptsize\faAngleRight\,}}

% the statuses' colours (the extension's own)
\definecolor{sidea}{HTML}{8D96A5}
\definecolor{sdrafting}{HTML}{3D7FE0}
\definecolor{ssubmitted}{HTML}{D8901A}
\definecolor{srevising}{HTML}{B35CD6}
\definecolor{saccepted}{HTML}{1FA463}
% a status, as its badge: tinted, a dot
\newcommand{\stat}[1]{\tikz[baseline=(t.base)]\node[rounded corners=5pt, fill=s#1!20, inner xsep=5pt, inner ysep=2.5pt, font=\footnotesize\color{ink}] (t) {\textcolor{s#1}{\tiny\faCircle}\,#1};}
% an Overleaf tag, as its badge
\newcommand{\tagchip}[1]{\tikz[baseline=(t.base)]\node[rounded corners=3pt, fill=mist, draw=line, line width=0.4pt, inner xsep=5pt, inner ysep=2.5pt, font=\footnotesize\color{ink2}] (t) {\textcolor{leaf}{\tiny\faCircle}\,#1};}

% a card: icon in a blue disc, a title, a body
\newtcolorbox{card}[2]{enhanced, colback=white, colframe=line, boxrule=0.6pt, arc=6pt,
  left=14pt, right=14pt, top=12pt, bottom=12pt, valign=top,
  fontupper=\small\color{ink2}\raggedright, before upper={%
    \tikz[baseline=-0.6ex]\node[circle, fill=leaf, text=white, minimum size=22pt, inner sep=0pt]{\normalsize #1};%
    \hspace{8pt}{\large\bfseries\color{ink}#2}\par\vspace{8pt}\setlength{\parskip}{5pt}}}

% a folder, drawn
\newcommand{\folder}[4]{% x, y, scale, colour
  \begin{scope}[shift={(#1,#2)}, scale=#3]
    \fill[#4!75!black, rounded corners=1.2pt] (0,0) -- (0,1.55) -- (0.75,1.55) -- (0.95,1.35) -- (2.2,1.35) -- (2.2,0) -- cycle;
    \fill[#4, rounded corners=1.5pt] (0,0) rectangle (2.2,1.2);
  \end{scope}}

\newcommand{\footer}{\begin{tikzpicture}[remember picture, overlay]
  \node[anchor=south, font=\scriptsize\color{slate}, inner sep=0pt] at ([yshift=1.3cm]current page.south)
    {PhiTeX Instant is an unofficial browser extension, not affiliated with Overleaf.\enspace\textcolor{line}{|}\enspace Storage format version 1};
\end{tikzpicture}}

\begin{document}

% ---- the band: what this is ----
\begin{tikzpicture}[remember picture, overlay]
  \fill[ink] (current page.north west) rectangle ([yshift=-8.6cm]current page.north east);
  \fill[leaf] ([yshift=-8.6cm]current page.north west) rectangle ([yshift=-8.75cm]current page.north east);
  % folders, stacked, on the right
  \begin{scope}[shift={([xshift=-6.9cm, yshift=-6.9cm]current page.north east)}]
    \begin{scope}[rotate around={8:(1.4,0)}] \folder{0.75}{1.55}{1.05}{ink2!70!slate} \end{scope}
    \begin{scope}[rotate around={-5:(1.4,0)}] \folder{0.2}{0.85}{1.18}{leaflight} \end{scope}
    \folder{0.3}{0}{1.35}{leaf}
    \node[text=white, font=\ttfamily\small] at (1.785,0.72) {folders.json};
    % a little nesting tree, beside
    \begin{scope}[shift={(4.0,3.5)}, every node/.style={font=\scriptsize, text=mist!70!slate, anchor=west, inner sep=1pt}]
      \draw[slate, line width=0.6pt] (0.05,-0.15) |- (0.3,-0.55) (0.05,-0.15) |- (0.3,-1.05) (0.35,-1.2) |- (0.6,-1.55);
      \node[text=leaflight] at (-0.05,0) {\faFolderOpen\enspace\textcolor{white}{Research}};
      \node at (0.3,-0.55) {\faFolder\enspace Thesis};
      \node at (0.3,-1.05) {\faFolder\enspace Papers};
      \node at (0.6,-1.55) {\faFolder\enspace 2026};
    \end{scope}
  \end{scope}
  \node[anchor=north west, text=leaflight, font=\small\bfseries, inner sep=0pt]
    at ([xshift=2.2cm, yshift=-2.1cm]current page.north west) {\MakeUppercase{PhiTeX Instant\enspace\textbullet\enspace Folders}\enspace\textcolor{slate}{\textbullet}\enspace\textcolor{mist!70!slate}{\mdseries unofficial}};
  \node[anchor=north west, text=white, font=\fontsize{34}{38}\selectfont\bfseries, inner sep=0pt, align=left]
    at ([xshift=2.2cm, yshift=-2.9cm]current page.north west) {Your folders\\live here.};
  \node[anchor=north west, text=mist!80!slate, font=\large, inner sep=0pt, text width=10.6cm, align=left]
    at ([xshift=2.2cm, yshift=-5.6cm]current page.north west)
    {This project holds the folders your project list is sorted into: which folders there are, how they nest, and which project sits in which.};
\end{tikzpicture}

\vspace*{9.45cm}
\hspace*{2.2cm}\begin{minipage}{16.6cm}

% ---- four cards ----
\begin{tcbraster}[raster columns=2, raster equal height=rows, raster column skip=12pt, raster row skip=12pt]
\begin{card}{\faFolderOpen}{Why a project?}
  Overleaf has tags, but no folders, and no place for an extension to keep them.
  A project of your own is that place: no other server, no account to make, and
  your folders follow you to every browser and device you sign in on.
\end{card}
\begin{card}{\faHistory}{Every change is a version}
  Each change you make to your folders is saved here, in \file{data/folders.json}.
  Overleaf's \textbf{History} keeps every version: to undo a reshuffle, restore an
  older one from there.
\end{card}
\begin{card}{\faListUl}{What's inside}
  \begin{itemize}[leftmargin=12pt, itemsep=3pt, topsep=0pt, label={\color{leaf}\textbullet}]
    \item \file{main.tex}: this page.
    \item \file{data/folders.json}: folder names, how they nest, the
      id of each project in them, and each one's status.
  \end{itemize}
  Nothing of your projects is copied here: no files, no text.
\end{card}
\begin{card}{\faUserShield}{Yours only}
  Like any project, only you can open it, unless you share it. It shows in
  your project list as any project does; to keep it out of the way, the
  extension's settings can hide it there (\textbf{Hide .phitex-data}).
\end{card}
\end{tcbraster}

\vspace{14pt}

% ---- how it moves ----
\begin{tikzpicture}[
  dev/.style={rounded corners=6pt, draw=line, line width=0.6pt, fill=white, minimum width=3.6cm, minimum height=1.55cm, align=center, font=\small\color{ink2}},
  hub/.style={rounded corners=8pt, fill=ink, text=white, minimum width=5.2cm, minimum height=1.9cm, align=center, font=\small},
  flow/.style={-{Stealth[length=7pt]}, line width=1.1pt, leaf}]
  \node[hub] (p) at (0,0) {{\color{leaflight}\faFolder}\enspace\textbf{this project}\\[2pt]{\ttfamily\footnotesize data/folders.json}};
  \node[dev, left=1.9cm of p] (a) {{\Large\color{leaf}\faLaptop}\\[3pt]your laptop};
  \node[dev, right=1.9cm of p] (b) {{\Large\color{leaf}\faDesktop}\\[3pt]any other browser};
  \draw[flow] ([yshift=5pt]a.east) -- node[above, font=\scriptsize\color{slate}]{saves} ([yshift=5pt]p.west);
  \draw[flow] ([yshift=-5pt]p.west) -- node[below, font=\scriptsize\color{slate}]{reads} ([yshift=-5pt]a.east);
  \draw[flow] ([yshift=5pt]b.west) -- node[above, font=\scriptsize\color{slate}]{saves} ([yshift=5pt]p.east);
  \draw[flow] ([yshift=-5pt]p.east) -- node[below, font=\scriptsize\color{slate}]{reads} ([yshift=-5pt]b.west);
  % history, under the hub
  \foreach \i in {0,...,5} \fill[leaf!35] ($(p.south)+(-1.5+\i*0.6,-0.75)$) circle (2.2pt);
  \fill[leaf] ($(p.south)+(1.5,-0.75)$) circle (3.2pt);
  \draw[line width=0.8pt, leaf!35] ($(p.south)+(-1.5,-0.75)$) -- ($(p.south)+(1.5,-0.75)$);
  \node[font=\scriptsize\color{slate}, anchor=north] at ($(p.south)+(0,-0.95)$) {History: every version, restorable};
\end{tikzpicture}

\vspace{16pt}

% ---- please ----
\begin{tcolorbox}[enhanced, colback=amberlight, colframe=amberlight, arc=6pt, left=14pt, right=14pt, top=10pt, bottom=10pt, fontupper=\small\color{ink2}]
  {\color{amber}\faExclamationTriangle}\enspace\textbf{\color{ink}Please leave this project as it is.}\enspace
  Renaming it, or moving or deleting \file{data/folders.json}, makes your browsers lose track of
  your folders (your projects themselves are never touched). If you stop using the extension,
  delete this project: that's all there is to remove.
\end{tcolorbox}

\vfill
\end{minipage}

\footer

% ==== page 2: how we suggest organizing ====
\newpage
\begin{tikzpicture}[remember picture, overlay]
  \fill[ink] (current page.north west) rectangle ([yshift=-4.6cm]current page.north east);
  \fill[leaf] ([yshift=-4.6cm]current page.north west) rectangle ([yshift=-4.75cm]current page.north east);
  \node[anchor=north west, text=leaflight, font=\small\bfseries, inner sep=0pt]
    at ([xshift=2.2cm, yshift=-1.55cm]current page.north west) {\MakeUppercase{Our suggestion}};
  \node[anchor=north west, text=white, font=\fontsize{26}{30}\selectfont\bfseries, inner sep=0pt]
    at ([xshift=2.2cm, yshift=-2.25cm]current page.north west) {Folders, statuses, tags};
  \node[anchor=north west, text=mist!80!slate, font=\large, inner sep=0pt]
    at ([xshift=2.2cm, yshift=-3.45cm]current page.north west) {Three questions about each project, each answered in its own place.};
\end{tikzpicture}

\vspace*{5.55cm}
\hspace*{2.2cm}\begin{minipage}{16.6cm}

\begin{tcbraster}[raster columns=3, raster equal height=rows, raster column skip=10pt]
\begin{card}{\faFolder}{Folder}
  {\color{leaf}\bfseries What is it?}\par
  One folder per project, for what doesn't change: a line of work, a course, a client.\par
  \file{\footnotesize Research\sep CGRA}\\[2pt]
  \file{\footnotesize Archive\sep Courses\sep CS 232}
\end{card}
\begin{card}{\faFlag}{Status}
  {\color{leaf}\bfseries Where does it stand?}\par
  One at a time, moving on as the work does. Make your own, as with tags;
  the \textbf{Status column} is in the extension's settings.\par
  \stat{drafting} \stat{submitted}
\end{card}
\begin{card}{\faTag}{Tag}
  {\color{leaf}\bfseries What else?}\par
  Overleaf's own tags: any number, across folders, for whatever cuts across.
  The table sorts by them too.\par
  \tagchip{with Alex} \tagchip{needs figures}
\end{card}
\end{tcbraster}

\vspace{12pt}

% ---- a paper's way ----
{\large\bfseries\color{ink}A paper's way}\enspace{\small\color{slate}the statuses to begin with: rename them, recolour them, add your own}\par\vspace{8pt}
\begin{tikzpicture}[
  st/.style={rounded corners=7pt, minimum width=2.5cm, minimum height=0.95cm, font=\small\color{ink}},
  go/.style={-{Stealth[length=6pt]}, line width=1pt, slate!70}]
  \foreach \s/\n [count=\i] in {idea/notes, drafting/being written, submitted/under review, revising/rebuttal, accepted/camera-ready} {
    \node[st, fill=s\s!18, draw=s\s!60, line width=0.6pt] (s\i) at (\i*3.25, 0) {\textcolor{s\s}{\scriptsize\faCircle}\enspace\textbf{\s}};
    \node[font=\scriptsize\color{slate}, below=3pt of s\i] {\n};
  }
  \foreach \i [evaluate=\i as \j using int(\i+1)] in {1,...,4} \draw[go] (s\i) -- (s\j);
  % (rejected, or major revision: back to a submission)
  \draw[go, dashed, rounded corners=8pt] (s4.north) -- ++(0,0.5) -| node[pos=0.25, above, font=\scriptsize\color{slate}] {resubmitted} (s3.north);
\end{tikzpicture}

\vspace{12pt}

% ---- how it looks ----
{\large\bfseries\color{ink}How it looks}\par\vspace{8pt}
\begin{tcolorbox}[enhanced, colback=white, colframe=line, boxrule=0.6pt, arc=6pt, left=0pt, right=0pt, top=0pt, bottom=0pt]
\renewcommand{\arraystretch}{1.75}
\setlength{\tabcolsep}{8pt}
\arrayrulecolor{line}
\small\color{ink2}
\begin{tabular}{@{\hspace{14pt}}p{6.0cm} p{2.3cm} p{2.8cm} >{\raggedleft\arraybackslash}p{2.4cm}@{\hspace{14pt}}}
  \multicolumn{4}{@{\hspace{14pt}}l}{\footnotesize\color{slate}All projects\sep Research\sep \textcolor{ink}{\bfseries CGRA}} \\[-4pt]
  \color{slate}\footnotesize Title & \color{slate}\footnotesize Status & \color{slate}\footnotesize Tags & \color{slate}\footnotesize Last modified \\ \hline
  \textcolor{slate}{\faFolder}\enspace Workshop papers & & & 2 days ago \\ \hline
  Sparse Attention on CGRAs (ISCA 2027) & \stat{submitted} & \tagchip{with Alex} & 3 days ago \\ \hline
  Loop Pipelining, Revisited & \stat{drafting} & \tagchip{needs figures} & yesterday \\ \hline
  A Survey of CGRA Mapping & \stat{idea} & & 2 months ago \\
\end{tabular}
\end{tcolorbox}

\vspace{12pt}

% ---- rules of thumb ----
{\large\bfseries\color{ink}Rules of thumb}\par\vspace{8pt}
\begin{itemize}[leftmargin=26pt, itemsep=7pt, topsep=0pt, label={}]
  \item[\textcolor{leaf}{\faLightbulb}] Name folders for what lasts: a topic, a course, a client. Not a year, not a deadline.
  \item[\textcolor{leaf}{\faArchive}] Keep the top level short. What's finished goes into an \file{Archive} folder: out of the way, still searchable.
  \item[\textcolor{leaf}{\faMapMarker*}] A venue belongs in the project's name. A paper that's resubmitted changes venue: it's neither a folder nor a status.
\end{itemize}

\vfill
\end{minipage}
\footer
\end{document}
`;
