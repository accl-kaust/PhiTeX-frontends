// "Report this": a GitHub issue or an email, drafted with the debug info in
// it, for the person to read and send (issue #39: the reporter couldn't
// find the debug info, nor how to send it). Nothing is sent from here: a
// link opens a draft in GitHub or the mail app. A draft too long for a link
// (GitHub's and mail apps' limits) leaves the debug info on the clipboard,
// the draft saying to paste it.

/** Where reports go: the project's issues (the bug form, .github/ISSUE_TEMPLATE/crash.yml) and its mail. */
export const ISSUES = "https://github.com/accl-kaust/PhiTeX/issues/new";
export const MAIL = "flinner@nand.sh";
/** The longest link drafted with the debug info in it; past it, the clipboard (GitHub refuses URLs over ~8 KB, mail apps cut far shorter). */
const MAX_ISSUE_URL = 7000, MAX_MAILTO = 1800;
const PASTE = "(The debug info is on your clipboard: paste it here.)";

/** The two drafts for `info` (the debug info), and whether each needs it pasted from the clipboard. */
export function reportLinks(info: string, title = "Overleaf: PhiTeX Instant problem"): { issue: string; mail: string; issuePaste: boolean; mailPaste: boolean } {
  const issueAt = (report: string) => `${ISSUES}?template=crash.yml&title=${encodeURIComponent(title)}&report=${encodeURIComponent(report)}`;
  const mailAt = (body: string) => `mailto:${MAIL}?subject=${encodeURIComponent(`PhiTeX: ${title}`)}&body=${encodeURIComponent(body)}`;
  const mailBody = (report: string) => `What I was doing:\n\n\nThe debug info:\n${report}`;
  const issue = issueAt(info), mail = mailAt(mailBody(info));
  const issuePaste = issue.length > MAX_ISSUE_URL, mailPaste = mail.length > MAX_MAILTO;
  return { issue: issuePaste ? issueAt(PASTE) : issue, mail: mailPaste ? mailAt(mailBody(PASTE)) : mail, issuePaste, mailPaste };
}

/**
 * A "Report this" row: GitHub issue · Email, each opening a draft with the
 * debug info (`info()`, read when the row is made and again at the click);
 * a draft that can't hold it copies it first, and says so. `note`: where
 * the row says what happens.
 */
export function reportRow(info: () => Promise<string>, title?: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "phx-report";
  row.style.cssText = "margin-top:8px;font-size:12px;line-height:1.5";
  const issue = document.createElement("a"), mail = document.createElement("a"), note = document.createElement("div");
  issue.className = "phx-report-issue";
  mail.className = "phx-report-mail";
  issue.textContent = "GitHub issue";
  mail.textContent = "Email";
  // (in the panel's colours, light or dark: its text's, underlined)
  for (const a of [issue, mail]) a.style.cssText = "color:inherit;text-decoration:underline;cursor:pointer;font-weight:600";
  issue.target = "_blank";
  issue.rel = "noopener";
  note.className = "phx-report-note";
  note.style.opacity = ".75";
  note.textContent = "Each opens a draft with the debug info for you to read first. Nothing is sent until you send it.";
  row.append("Report this: ", issue, " · ", mail, note);
  const fill = async () => {
    const l = reportLinks(await info(), title);
    issue.href = l.issue;
    mail.href = l.mail;
    return { l, text: await info() };
  };
  void fill();
  const go = (which: "issue" | "mail") => async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { l, text } = await fill();
    if (which === "issue" ? l.issuePaste : l.mailPaste) {
      await navigator.clipboard.writeText(text).catch(() => undefined);
      note.textContent = "The debug info is too long for a link: it is on your clipboard, paste it into the draft.";
    }
    window.open(which === "issue" ? l.issue : l.mail, "_blank", "noopener");
  };
  issue.onclick = go("issue");
  mail.onclick = go("mail");
  return row;
}
