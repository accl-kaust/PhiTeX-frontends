// The web frontend's own chrome (the bar, the files, the menus, the
// dialogs, the editor's frame) in PhiTeX's palette, the panel's watch
// host's tokens (phitex/viewer/src/print.ts WATCH, WATCH_DARK: navy,
// orange for what is current), so the app and the panel match; light or
// dark as the page is: the page's own toggle (data-theme on the root,
// "dark" or "light"), else the system's. The panel keeps its own sheet in
// its shadow root, told the same (Panel.theme).

/** The dark tokens (WATCH_DARK's), for both ways a page is dark. */
const DARK = `--bg: #161b23; --bg2: #1b212b; --hover: #222935; --line: #262d38; --fg: #e7e9ee; --fg2: #98a1b0;
  --accent: #2c5aa0; --accent-hover: #3567b3; --danger: #f0786d; --link: #8fb3ec; --sel: #23324a; color-scheme: dark;`;

export const CSS = `
.phx-web { --bg: #fff; --bg2: #f6f7f9; --hover: #eef1f6; --line: #e3e6ec; --fg: #1b222c; --fg2: #5d6778;
  --accent: #1d3e72; --accent-hover: #16325d; --danger: #c23a2f; --link: #1d3e72; --sel: #e3eaf5; --current: #f58f2d; color-scheme: light;
  position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; background: var(--bg); color: var(--fg);
  font: 13px/1.4 "Noto Sans", system-ui, sans-serif; }
.phx-web * { box-sizing: border-box; }
.phx-web button, .phx-web select, .phx-web input { font: inherit; color: inherit; }
.phx-web .grow { flex: 1; }
.phx-web .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.phx-bar { flex: none; display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 8px; border-bottom: 1px solid var(--line); background: var(--bg);
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
.phx-bar > * { flex: none; }
.phx-logo { font-weight: 700; margin-right: 6px; }
.phx-bar > button, .phx-menu > button { height: 28px; padding: 0 10px; border: 0; border-radius: 4px; background: none; cursor: pointer; white-space: nowrap; }
.phx-bar > button:hover, .phx-menu > button:hover, .phx-menu > button[aria-expanded="true"] { background: var(--hover); }
.phx-bar > button[aria-pressed="true"] { background: var(--sel); box-shadow: inset 0 -2px var(--current); font-weight: 600; }
.phx-bar select { height: 28px; max-width: 200px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); padding: 0 4px; }
.phx-proj { display: inline-flex; align-items: center; gap: 6px; margin-right: 6px; }
.phx-proj .cap { color: var(--fg2); font-size: 12px; }
.phx-proj select { min-width: 150px; height: 30px; padding: 0 8px; font-weight: 600; border-color: var(--fg2); cursor: pointer; }
.phx-proj select:hover { background: var(--bg2); }
.phx-proj select.ringed { outline: 2px solid var(--current); outline-offset: 2px; }
.phx-tip { position: absolute; z-index: 50; width: 300px; padding: 12px 14px; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
  border-radius: 8px; box-shadow: 0 8px 28px rgb(27 34 44 / 25%); }
.phx-tip::before { content: ""; position: absolute; top: -6px; left: var(--ax, 40px); width: 10px; height: 10px; background: var(--bg);
  border-left: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg); }
.phx-tip h4 { margin: 0 0 8px; font-size: 13px; }
.phx-tip p { margin: 0 0 10px; color: var(--fg2); line-height: 1.45; }
.phx-tip .acts { display: flex; justify-content: flex-end; gap: 6px; }
.phx-tip .acts button { height: 28px; padding: 0 12px; border: 0; border-radius: 14px; background: none; color: var(--link); cursor: pointer; }
.phx-tip .acts .primary { background: var(--accent); color: #fff; font-weight: 600; }
.phx-tip .acts .primary:hover { background: var(--accent-hover); }
/* (the demo: the picker opens, the highlight walks the examples, lands on one, closes) */
.phx-tip .demo { position: relative; height: 120px; margin-bottom: 10px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg2); overflow: hidden; font-size: 11px; }
.phx-tip .pick { display: inline-flex; gap: 18px; align-items: center; padding: 3px 8px; border: 1px solid var(--fg2); border-radius: 4px; background: var(--bg); animation: phx-tip-press 5s infinite; }
.phx-tip .list { position: absolute; left: 8px; top: 32px; width: 150px; padding: 3px 0; display: flex; flex-direction: column; background: var(--bg);
  border: 1px solid var(--line); border-radius: 4px; box-shadow: 0 3px 10px rgb(27 34 44 / 18%); opacity: 0; transform-origin: top; animation: phx-tip-open 5s infinite; }
.phx-tip .list small { padding: 1px 8px; color: var(--fg2); font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
.phx-tip .list span { position: relative; z-index: 1; padding: 1px 14px; line-height: 13px; }
.phx-tip .list .hi { position: absolute; left: 2px; right: 2px; top: 17px; height: 13px; border-radius: 2px; background: var(--sel); animation: phx-tip-walk 5s infinite; }
@keyframes phx-tip-press { 0%, 8% { background: var(--bg); } 12%, 80% { background: var(--hover); } 86%, 100% { background: var(--bg); } }
@keyframes phx-tip-open { 0%, 10% { opacity: 0; transform: scaleY(.9); } 16%, 78% { opacity: 1; transform: none; } 84%, 100% { opacity: 0; } }
@keyframes phx-tip-walk { 0%, 22% { transform: translateY(0); } 34% { transform: translateY(13px); } 46% { transform: translateY(26px); } 58%, 78% { transform: translateY(39px); background: var(--current); } 100% { transform: translateY(39px); } }
@media (prefers-reduced-motion: reduce) { .phx-tip .demo * { animation: none !important; } .phx-tip .list { opacity: 1; } }
.phx-engine { display: inline-flex; align-items: center; gap: 4px; color: var(--fg2); }
:root[data-theme="dark"] .phx-web { ${DARK} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .phx-web { ${DARK} } }
.phx-web :focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.phx-web input:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 1px var(--link); }
.phx-menu { position: static; }
.phx-pop { position: fixed; z-index: 40; min-width: 240px; max-height: 60vh; overflow: auto; padding: 4px 0; background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 6px 20px rgb(27 34 44 / 20%); }
.phx-pop[hidden] { display: none; }
.phx-pop > button, .phx-pop .phx-item { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 6px 14px; border: 0; background: none; text-align: left; cursor: pointer; }
.phx-pop > button:hover, .phx-pop .phx-item:hover { background: var(--hover); }
.phx-pop small { color: var(--fg2); white-space: nowrap; }
.phx-pop hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
.phx-pop .phx-head { padding: 6px 14px 2px; color: var(--fg2); font-size: 12px; }
.phx-pop .phx-none { padding: 6px 14px; color: var(--fg2); }
.phx-pop .danger, .phx-acts .danger { color: var(--danger); }
.phx-save, .phx-form { display: flex; gap: 6px; padding: 6px 10px; }
.phx-save input, .phx-form input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
.phx-save button, .phx-form button, .phx-acts button { height: 28px; padding: 0 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg2); cursor: pointer; }
.phx-save button, .phx-form button { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.phx-save button:hover, .phx-form button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.phx-acts button:hover { background: var(--hover); }
.phx-body { flex: 1; min-height: 0; display: flex; }
.phx-tree { flex: none; width: 200px; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--bg2); overflow: auto; }
.phx-tree-head { display: flex; align-items: center; gap: 2px; height: 32px; padding: 0 6px 0 12px; color: var(--fg2); font-size: 12px; font-weight: 600; }
.phx-tree-head button, .phx-tree-head .up { width: 26px; height: 26px; display: inline-grid; place-items: center; border: 0; border-radius: 4px; background: none; cursor: pointer; font-size: 15px; }
.phx-tree-head button:hover, .phx-tree-head .up:hover { background: var(--hover); }
.phx-tree-list { list-style: none; margin: 0; padding: 0 0 8px; }
.phx-tree-list li { display: flex; align-items: center; height: 28px; padding: 0 4px 0 12px; cursor: pointer; }
.phx-tree-list li:hover { background: var(--hover); }
.phx-tree-list li.on { background: var(--sel); box-shadow: inset 3px 0 var(--current); font-weight: 600; }
.phx-tree-list li.bin { color: var(--fg2); cursor: default; }
.phx-tree-list .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.phx-tree-list .acts { display: none; }
.phx-tree-list li:hover .acts, .phx-tree-list li:focus-within .acts { display: flex; }
.phx-tree-list .acts button { width: 22px; height: 22px; border: 0; border-radius: 3px; background: none; cursor: pointer; color: var(--fg2); }
.phx-tree-list .acts button:hover { background: var(--bg); color: var(--fg); }
.phx-tree-name { padding: 4px 8px; }
.phx-tree-name[hidden] { display: none; }
.phx-tree-name input { width: 100%; height: 26px; padding: 0 6px; border: 1px solid var(--line); border-radius: 4px; }
.phx-ed { flex: 1 1 45%; min-width: 0; display: flex; border-right: 1px solid var(--line); }
.phx-ed .cm-editor { flex: 1; min-width: 0; height: 100%; }
.phx-pages { flex: 1 1 55%; min-width: 0; position: relative; }
.phx-modal { position: absolute; inset: 0; z-index: 60; display: grid; place-items: center; background: rgb(27 34 44 / 40%); }
.phx-modal[hidden] { display: none; }
.phx-card { width: min(720px, calc(100% - 32px)); max-height: calc(100% - 48px); display: flex; flex-direction: column; background: var(--bg); border-radius: 8px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 30%); }
.phx-card header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--line); }
.phx-card header button { width: 28px; height: 28px; border: 0; border-radius: 4px; background: none; cursor: pointer; }
.phx-modal-body { padding: 12px 16px 16px; overflow: auto; }
.phx-modal-body p { margin: 0 0 10px; }
.phx-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.phx-versions { display: flex; flex-direction: column; margin: 0 -16px; }
.phx-versions button { display: flex; justify-content: space-between; gap: 12px; padding: 7px 16px; border: 0; background: none; text-align: left; cursor: pointer; }
.phx-versions button:hover { background: var(--hover); }
.phx-versions small, .phx-modal .phx-head, .phx-modal .phx-none { color: var(--fg2); }
.phx-modal .phx-save { padding: 0 0 10px; }
.phx-narrow { display: none; }
@media (max-width: 760px) {
  .phx-narrow { display: inline-block; }
  .phx-engine, .phx-logo { display: none; }
  .phx-body { flex-direction: column; }
  .phx-tree { display: none; position: absolute; z-index: 30; top: 40px; bottom: 0; left: 0; width: min(260px, 80%); box-shadow: 4px 0 16px rgb(0 0 0 / 20%); }
  .phx-web.files-on .phx-tree { display: flex; }
  .phx-ed { flex: 0 0 40%; border-right: 0; border-bottom: 1px solid var(--line); }
  .phx-pages { flex: 1 1 60%; }
}`;
