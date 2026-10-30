// The web frontend's own chrome (the bar, the files, the menus, the
// dialogs), in Overleaf's palette and font so it sits with the panel; the
// panel keeps its own sheet in its shadow root.

export const CSS = `
.phx-web { --bg: #fff; --bg2: #f4f5f6; --line: #e7e9ee; --fg: #1b222c; --fg2: #495365; --accent: #098842; --danger: #b83a33;
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
.phx-bar > button:hover, .phx-menu > button:hover, .phx-menu > button[aria-expanded="true"] { background: var(--bg2); }
.phx-bar > button[aria-pressed="true"] { background: var(--line); font-weight: 600; }
.phx-bar select { height: 28px; max-width: 200px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); padding: 0 4px; }
.phx-engine { display: inline-flex; align-items: center; gap: 4px; color: var(--fg2); }
.phx-web :focus-visible { outline: 2px solid #366cbf; outline-offset: 1px; }
.phx-menu { position: static; }
.phx-pop { position: fixed; z-index: 40; min-width: 240px; max-height: 60vh; overflow: auto; padding: 4px 0; background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 6px 20px rgb(27 34 44 / 20%); }
.phx-pop[hidden] { display: none; }
.phx-pop > button, .phx-pop .phx-item { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 6px 14px; border: 0; background: none; text-align: left; cursor: pointer; }
.phx-pop > button:hover, .phx-pop .phx-item:hover { background: var(--bg2); }
.phx-pop small { color: var(--fg2); white-space: nowrap; }
.phx-pop hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
.phx-pop .phx-head { padding: 6px 14px 2px; color: var(--fg2); font-size: 12px; }
.phx-pop .phx-none { padding: 6px 14px; color: var(--fg2); }
.phx-pop .danger, .phx-acts .danger { color: var(--danger); }
.phx-save, .phx-form { display: flex; gap: 6px; padding: 6px 10px; }
.phx-save input, .phx-form input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; }
.phx-save button, .phx-form button, .phx-acts button { height: 28px; padding: 0 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg2); cursor: pointer; }
.phx-save button, .phx-form button { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.phx-body { flex: 1; min-height: 0; display: flex; }
.phx-tree { flex: none; width: 200px; display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--bg2); overflow: auto; }
.phx-tree-head { display: flex; align-items: center; gap: 2px; height: 32px; padding: 0 6px 0 12px; color: var(--fg2); font-size: 12px; font-weight: 600; }
.phx-tree-head button, .phx-tree-head .up { width: 26px; height: 26px; display: inline-grid; place-items: center; border: 0; border-radius: 4px; background: none; cursor: pointer; font-size: 15px; }
.phx-tree-head button:hover, .phx-tree-head .up:hover { background: var(--line); }
.phx-tree-list { list-style: none; margin: 0; padding: 0 0 8px; }
.phx-tree-list li { display: flex; align-items: center; height: 28px; padding: 0 4px 0 12px; cursor: pointer; }
.phx-tree-list li:hover { background: var(--line); }
.phx-tree-list li.on { background: #dfe7f5; }
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
.phx-versions button:hover { background: var(--bg2); }
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
