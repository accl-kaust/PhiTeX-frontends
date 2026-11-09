-- PhiTeX's live preview in Neovim (0.11): `phitex watch --lsp` as the
-- language server of TeX files. The editor's buffer is built as you type,
-- TeX's errors are diagnostics, a double-click on a page opens its source
-- here (window/showDocument), and the cursor's word and line, and a visual
-- selection's text, are marked on the page as you move (phitex/cursor with
-- its range). The pages are
-- in a browser tab the watch serves (<leader>lv opens it).
--
-- What the engine is doing (phitex/status: building, the last build's
-- time, its problems) is PhitexStatus()'s, for your statusline:
--   vim.o.statusline = "%f %m%=%{v:lua.PhitexStatus()} "
-- Its progress (fetching a package, typesetting) is Neovim's own LSP
-- progress (vim.lsp.status(), or a plugin such as fidget.nvim).
--
-- Commands: :PhiTeXInstall, :PhiTeXViewer, :PhiTeXStop, :PhiTeXRestart, :PhiTeXRebuild,
-- :PhiTeXSavePdf [path], :PhiTeXCaches, :PhiTeXClearCache [build|packages|all].
--
-- Settings (docs/spec-editor-protocol.md §3.5), in PhitexSettings before
-- this file runs, e.g. PhitexSettings = { threads = 4, follow = "selection" }:
-- threads (default: one), main ("paper.tex"), follow ("cursor": the
-- words at the cursor marked on the page; "selection": only a selection's;
-- "dblclick": nothing as you move).
--
-- Put this file in your config (e.g. ~/.config/nvim/plugin/phitex.lua), or
-- add the repository with its folder apps/editors/nvim on the runtimepath
-- (plugin/phitex.lua there runs this file): vim-plug's
-- Plug 'accl-kaust/PhiTeX-frontends', { 'rtp': 'apps/editors/nvim' }, or
-- with lazy.nvim: { "accl-kaust/PhiTeX-frontends", config = function(p) dofile(p.dir .. "/apps/editors/nvim/phitex.lua") end }.
-- With no `phitex` on PATH, it asks before downloading the latest release
-- into ~/.local/bin (:PhiTeXInstall does the same). That needs minisign and
-- curl: the release's SHA256SUMS must verify against the release key below,
-- and the download must match it, or nothing is installed. A project with several .tex files names its
-- main one in phitex.toml (`main = "paper.tex"`) or in init_options.

-- (once: a plugin manager's loader and a config's dofile may both run it)
if vim.g.loaded_phitex then return end
-- (the oldest Neovim it runs on, tested by CI (.github/workflows/editors.yml): older, said once, nothing set up)
if vim.fn.has("nvim-0.11") == 0 then
  vim.notify("PhiTeX needs Neovim 0.11 or later.", vim.log.levels.ERROR)
  return
end
vim.g.loaded_phitex = true

--- This file, as the server is told (initializationOptions.client: docs/spec-editor-protocol.md §1).
local CLIENT = { name = "phitex.nvim", version = "0.1.0" }
--- The editor protocol this file speaks: an older server's (capabilities.experimental.phitex.protocol) is said.
local PROTOCOL = 1

--- phitex/status, per client.
local status = {}

--- The statusline's text: "⚡ 67 ms ✗2", "⚡ typesetting p. 3", ... ("" with no watch).
function PhitexStatus()
  local c = vim.lsp.get_clients({ bufnr = 0, name = "phitex" })[1]
  local s = c and status[c.id]
  if not s then return c and "⚡" or "" end
  local problems = ((s.errors or 0) > 0 and (" ✗" .. s.errors) or "") .. ((s.warnings or 0) > 0 and (" ⚠" .. s.warnings) or "")
  if s.state == "ready" then return "⚡ " .. (s.ms and (math.floor(s.ms + 0.5) .. " ms") or "ready") .. problems end
  if s.state == "fetching" then return "⚡ fetching " .. (s.name or "packages") end
  if s.state == "typesetting" then return "⚡ typesetting" .. (s.pages and (" p. " .. s.pages) or "") end
  if s.state == "failed" then return "⚡ failed" .. problems end
  return "⚡ " .. s.state
end

local function client()
  local c = vim.lsp.get_clients({ bufnr = 0, name = "phitex" })[1]
  if not c then vim.notify("PhiTeX: no watch for this buffer", vim.log.levels.WARN) end
  return c
end

--- The watch's command `name` (docs/spec-editor-protocol.md), `done` given its answer.
local function exec(name, args, done)
  local c = client()
  if not c then return end
  c:request("workspace/executeCommand", { command = name, arguments = args }, function(err, result)
    if err then return vim.notify("PhiTeX: " .. (err.message or vim.inspect(err)), vim.log.levels.ERROR) end
    if done then done(result) end
  end, 0)
end

local function size(b)
  if b >= 1073741824 then return string.format("%.1f GB", b / 1073741824) end
  if b >= 1048576 then return string.format("%.0f MB", b / 1048576) end
  return string.format("%.0f kB", b / 1024)
end

PhitexSettings = PhitexSettings or {}

--- Which releases :PhiTeXInstall downloads (`channel`, as install.sh's PHITEX_CHANNEL: "stable", the latest
--- release, or "nightly", dev's rebuilt each night; nightly until v1.0 is tagged, GitHub's latest release
--- skipping pre-releases: the release checklist flips it), where from (`base`, nil: the channel's), the
--- minisign public key it is checked against (`key`, nil: the channel's, PhiTeX's ci/minisign.pub for
--- releases, ci/nightly.pub for the nightly, as install.sh), the folder whose bin/ it fills.
PhitexInstall = vim.tbl_extend("keep", PhitexInstall or {}, {
  channel = "nightly",
  base = nil,
  key = nil,
  prefix = vim.fn.expand("~/.local"),
})
local INSTALL_SCRIPT = [==[
set -eu
base=$1 key=$2 prefix=$3 channel=$4
command -v minisign >/dev/null || { echo "minisign is not installed: the download could not be checked"; exit 1; }
case "$(uname -s)" in Linux) os=linux;; Darwin) os=macos;; *) echo "no build for $(uname -s)"; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x86_64;; aarch64|arm64) arch=aarch64;; *) echo "no build for $(uname -m)"; exit 1;; esac
asset=phitex-$arch-$os.tar.gz
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for f in SHA256SUMS SHA256SUMS.minisig "$asset"; do
  curl -fsSL --proto-redir '=https' -o "$tmp/$f" "$base/$f" || { echo "could not download $base/$f"; exit 1; }
done
minisign -Vqm "$tmp/SHA256SUMS" -x "$tmp/SHA256SUMS.minisig" -P "$key" || { echo "the signature does not verify: nothing installed"; exit 1; }
want=$(awk -v f="$asset" '$2 == f || $2 == "*" f {print $1}' "$tmp/SHA256SUMS")
if command -v sha256sum >/dev/null; then got=$(sha256sum "$tmp/$asset" | cut -d" " -f1); else got=$(shasum -a 256 "$tmp/$asset" | cut -d" " -f1); fi
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "$asset does not match SHA256SUMS: nothing installed"; exit 1; }
tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/phitex" ] || { echo "$asset has no phitex binary"; exit 1; }
mkdir -p "$prefix/bin"
cp "$tmp/phitex" "$prefix/bin/.phitex.new"; chmod 755 "$prefix/bin/.phitex.new"; mv -f "$prefix/bin/.phitex.new" "$prefix/bin/phitex"
data=${XDG_DATA_HOME:-$HOME/.local/share}/phitex; mkdir -p "$data"
printf '{"method": "script", "prefix": "%s", "asset": "%s", "channel": "%s"}\n' "$prefix" "$asset" "$channel" > "$data/install.json"
]==]
local declined = false

--- Ask, then download the latest release, checked against its signature; whether it is installed.
local CHANNELS = {
  stable = "https://github.com/accl-kaust/PhiTeX/releases/latest/download",
  nightly = "https://github.com/accl-kaust/PhiTeX/releases/download/nightly",
}
local KEYS = {
  stable = "RWS/tPWBRVVf0Y9h/ODPiO2EgZi1labeCog3siaCfIdaC9HJkDJZ8k4u",
  nightly = "RWT5jA+G82gT+bMpGqolUeaWPm6OYkLC4m6lI8G5HbUnyL3yY5UpGCYD",
}

local function install()
  local i = PhitexInstall
  local base = i.base or CHANNELS[i.channel]
  if not base then
    vim.notify(string.format('PhiTeX: PhitexInstall.channel is "stable" or "nightly", not %q', tostring(i.channel)), vim.log.levels.ERROR)
    return false
  end
  if vim.fn.executable("minisign") == 0 then
    vim.notify("PhiTeX: installing needs minisign, to check the download's signature: install it, or phitex itself (https://phitex.org)", vim.log.levels.ERROR)
    return false
  end
  local q = string.format("Download PhiTeX (%s) from %s into %s/bin, checked against its signature?", i.channel, base, i.prefix)
  if vim.fn.confirm(q, "&Yes\n&No", 2) ~= 1 then
    declined = true
    return false
  end
  local r = vim.system({ "sh", "-c", INSTALL_SCRIPT, "sh", base, i.key or KEYS[i.channel], i.prefix, i.channel }, { text = true }):wait()
  if r.code ~= 0 then
    vim.notify(string.format("PhiTeX: not installed from the %s channel (%s): %s", i.channel, base, vim.trim((r.stdout or "") .. (r.stderr or ""))), vim.log.levels.ERROR)
    return false
  end
  vim.env.PATH = i.prefix .. "/bin:" .. vim.env.PATH
  vim.notify("PhiTeX: installed in " .. i.prefix .. "/bin")
  return true
end

--- A `phitex` to run: on PATH, in the install folder, or downloaded when the user agrees.
local function ensure_binary()
  if vim.fn.executable("phitex") == 1 then return true end
  local bin = PhitexInstall.prefix .. "/bin"
  if vim.fn.executable(bin .. "/phitex") == 1 then
    vim.env.PATH = bin .. ":" .. vim.env.PATH
    return true
  end
  if declined then return false end
  return install()
end

--- The running watches, as `phitex sessions --json` lists them (one started in a
--- terminal, any editor's): none with no phitex, or one too old to list them.
local function sessions()
  if vim.fn.executable("phitex") ~= 1 then return {} end
  local ok, r = pcall(function() return vim.system({ "phitex", "sessions", "--json" }, { text = true }):wait(3000) end)
  if not ok or r.code ~= 0 then return {} end
  local fine, list = pcall(vim.json.decode, r.stdout or "")
  return fine and type(list) == "table" and list or {}
end

--- The running watch for `file`: the one whose main file it is, else the deepest folder holding it.
local function session_for(file)
  local best
  for _, s in ipairs(sessions()) do
    local root, main = s.root, s.main
    if type(root) == "string" and type(s.lsp) == "table" and (main == file or vim.startswith(file, root .. "/")) then
      if main == file then return s end
      if not best or #root > #best.root then best = s end
    end
  end
  return best
end

--- Clients attached to a watch this Neovim did not start, by id.
local attached = {}

--- The buffer's watch: `mode` (vim.g.phitex_attach, "auto" by default) "auto"
--- uses a running one whose folder holds the file (`phitex sessions`: one
--- started in a terminal), else starts one; "always" only a running one;
--- "never" always starts one.
local function start(buf, mode)
  mode = mode or vim.g.phitex_attach or "auto"
  local file = vim.api.nvim_buf_get_name(buf)
  local session = mode ~= "never" and session_for(file) or nil
  if mode == "always" and not session then
    vim.notify("PhiTeX: no phitex watch is running for this file (phitex sessions lists them).", vim.log.levels.ERROR)
    return nil
  end
  if not session and not ensure_binary() then return nil end
  local init = vim.tbl_extend("force", PhitexSettings, { client = CLIENT, phitexCursor = true })
  -- (a watch started elsewhere: its language server on 127.0.0.1, by its token)
  if session then init.token = session.lsp.token end
  local id = vim.lsp.start({
    -- (the engine's settings: at the start, and when it asks)
    -- (phitexCursor: phitex/cursor is sent here, so a documentHighlight makes no second forward search)
    init_options = init,
    settings = { phitex = PhitexSettings },
    name = "phitex",
    cmd = session and vim.lsp.rpc.connect(session.lsp.host, session.lsp.port) or { "phitex", "watch", "--lsp" },
    -- (a project is phitex.toml's folder, else the file's own: a TeX
    -- project often sits in a folder of a larger git repository; attached,
    -- the watch's own)
    root_dir = session and session.root or vim.fs.root(buf, { "phitex.toml" }) or vim.fs.dirname(vim.api.nvim_buf_get_name(buf)),
    -- init_options = { main = "paper.tex" },
    handlers = {
      ["phitex/status"] = function(_, s, ctx)
        status[ctx.client_id] = s
        vim.cmd.redrawstatus()
      end,
    },
    -- (a phitex older than this file's protocol: said, the watch kept)
    on_init = function(c, result)
      if session then
        attached[c.id] = true
        vim.schedule(function() vim.notify(string.format("PhiTeX: attached to the watch of %s (pid %s).", session.main, session.pid)) end)
      end
      local p = vim.tbl_get(result, "capabilities", "experimental", "phitex", "protocol")
      if type(p) ~= "number" or p < PROTOCOL then
        local v = vim.tbl_get(result, "serverInfo", "version") or "(of an unknown version)"
        vim.schedule(function() vim.notify("PhiTeX: phitex " .. v .. " is too old for this phitex.lua. Run `phitex upgrade` in a terminal, then :PhiTeXRestart.", vim.log.levels.ERROR) end)
      end
    end,
    on_exit = function(code, signal, client_id)
      status[client_id] = nil
      -- (attached: the watch keeps running where it was started)
      if attached[client_id] then
        attached[client_id] = nil
        vim.schedule(function() vim.notify("PhiTeX: detached from the watch (it keeps running where it was started).") end)
        return
      end
      -- (an exit not asked for: said, with how to start it again)
      if code ~= 0 or signal ~= 0 then
        vim.schedule(function() vim.notify(string.format("PhiTeX: phitex watch exited (code %d). :PhiTeXRestart starts it again.", code), vim.log.levels.ERROR) end)
      end
    end,
  }, {
    bufnr = buf,
    -- (a watch already running in a folder holding this file, its phitex/status
    -- root: one started for a chapter that found its main file a folder up)
    reuse_client = function(c, config)
      local r = status[c.id] and status[c.id].root
      if type(r) == "string" and r ~= "" and vim.startswith(file, r .. "/") then return true end
      return c.name == config.name and c.root_dir == config.root_dir
    end,
  })
  return id
end

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "tex", "plaintex", "bib" },
  callback = function(ev)
    start(ev.buf)
    -- (the cursor and its visual selection as they move, the latest at most every
    -- 30 ms: phitex/cursor with its range, an empty one clearing a selection's marks)
    local timer = vim.uv.new_timer()
    local pending, selected = false, false
    local function send()
      pending = false
      local c = vim.lsp.get_clients({ bufnr = ev.buf, name = "phitex" })[1]
      if not c or vim.api.nvim_get_current_buf() ~= ev.buf then return end
      local follow = PhitexSettings.follow or "cursor"
      local selecting = vim.fn.mode():match("^[vV\22]") ~= nil
      local ended = selected and not selecting
      if follow == "dblclick" or (follow == "selection" and not selecting and not ended) then return end
      selected = selecting
      local p = vim.lsp.util.make_position_params(0, "utf-16")
      if selecting then
        local v, cur = vim.fn.getpos("v"), vim.fn.getpos(".")
        local a, b = { v[2], v[3] - 1 }, { cur[2], cur[3] - 1 }
        if a[1] > b[1] or (a[1] == b[1] and a[2] > b[2]) then a, b = b, a end
        p.range = vim.lsp.util.make_given_range_params(a, b, ev.buf, "utf-16").range
      else
        p.range = { start = p.position, ["end"] = p.position }
      end
      c:notify("phitex/cursor", p)
    end
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "ModeChanged" }, {
      buffer = ev.buf,
      callback = function()
        if pending then return end
        pending = true
        timer:start(30, 0, vim.schedule_wrap(send))
      end,
    })
    vim.keymap.set("n", "<leader>lv", "<cmd>PhiTeXViewer<cr>", { buffer = ev.buf, desc = "PhiTeX: open the pages" })
  end,
})

-- (the watch ends with its last buffer: closed, or its client detached)
vim.api.nvim_create_autocmd("LspDetach", {
  callback = function(ev)
    local c = vim.lsp.get_client_by_id(ev.data.client_id)
    if not c or c.name ~= "phitex" then return end
    vim.schedule(function()
      local left = vim.tbl_filter(function(b) return b ~= ev.buf and vim.api.nvim_buf_is_loaded(b) end, vim.tbl_keys(c.attached_buffers))
      if #left == 0 and not c:is_stopped() then c:stop() end
    end)
  end,
})

vim.api.nvim_create_user_command("PhiTeXInstall", function() install() end, { desc = "PhiTeX: download the latest release, checked against its signature" })
vim.api.nvim_create_user_command("PhiTeXViewer", function() exec("phitex.openViewer") end, { desc = "PhiTeX: open the pages in a browser" })
vim.api.nvim_create_user_command("PhiTeXStop", function() exec("phitex.stop") end, { desc = "PhiTeX: stop the watch" })
vim.api.nvim_create_user_command("PhiTeXRebuild", function() exec("phitex.rebuild") end, { desc = "PhiTeX: build again from scratch" })
vim.api.nvim_create_user_command("PhiTeXAttach", function()
  local buf = vim.api.nvim_get_current_buf()
  for _, c in ipairs(vim.lsp.get_clients({ bufnr = buf, name = "phitex" })) do c:stop() end
  vim.defer_fn(function() start(buf, "always") end, 300)
end, { desc = "PhiTeX: attach to a phitex watch already running for this file (one started in a terminal)" })
vim.api.nvim_create_user_command("PhiTeXRestart", function()
  local buf = vim.api.nvim_get_current_buf()
  for _, c in ipairs(vim.lsp.get_clients({ name = "phitex" })) do c:stop() end
  -- (once stopped: a client still stopping holds the server's commands)
  vim.defer_fn(function() start(buf) end, 500)
end, { desc = "PhiTeX: start the watch again" })
vim.api.nvim_create_user_command("PhiTeXSavePdf", function(o)
  local to = o.args ~= "" and vim.fn.fnamemodify(o.args, ":p") or nil
  exec("phitex.savePdf", { { path = to } }, function(r) vim.notify("PhiTeX: PDF saved" .. (r and r.path and (" to " .. r.path) or "")) end)
end, { nargs = "?", complete = "file", desc = "PhiTeX: save the PDF" })
vim.api.nvim_create_user_command("PhiTeXCaches", function()
  exec("phitex.cacheStats", nil, function(r)
    local lines = {}
    for _, c in ipairs(r and r.caches or {}) do
      table.insert(lines, string.format("%-9s %8s  %6d entries  last used %s", c.scope, size(c.bytes or 0), c.entries or 0, c.last_used or "never"))
      table.insert(lines, string.format("          %s", c.location or ""))
      table.insert(lines, string.format("          this session: %d hits, %d misses", c.hits or 0, c.misses or 0))
    end
    table.insert(lines, "")
    table.insert(lines, ":PhiTeXClearCache [build|packages|all] clears one")
    vim.lsp.util.open_floating_preview(lines, "", { border = "rounded", title = " PhiTeX caches " })
  end)
end, { desc = "PhiTeX: the caches' sizes and use" })
vim.api.nvim_create_user_command("PhiTeXClearCache", function(o)
  local scope = o.args ~= "" and o.args or "build"
  exec("phitex.clearCache", { { scope = scope } }, function(r) vim.notify(string.format("PhiTeX: %s cache cleared, %s freed", scope, size(r and r.freed_bytes or 0))) end)
end, { nargs = "?", complete = function() return { "build", "packages", "all" } end, desc = "PhiTeX: clear a cache" })
