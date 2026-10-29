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
-- Commands: :PhiTeXViewer, :PhiTeXStop, :PhiTeXRestart, :PhiTeXRebuild,
-- :PhiTeXSavePdf [path], :PhiTeXCaches, :PhiTeXClearCache [build|packages|all].
--
-- Settings (docs/spec-editor-protocol.md §3.5), in PhitexSettings before
-- this file runs, e.g. PhitexSettings = { threads = 4, follow = "selection" }:
-- threads (default: one per core), main ("paper.tex"), follow ("cursor": the
-- words at the cursor marked on the page; "selection": only a selection's;
-- "dblclick": nothing as you move).
--
-- Put this file in your config (e.g. ~/.config/nvim/plugin/phitex.lua);
-- `phitex` must be on PATH. A project with several .tex files names its
-- main one in phitex.toml (`main = "paper.tex"`) or in init_options.

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

local function start(buf)
  local id = vim.lsp.start({
    -- (the engine's settings: at the start, and when it asks)
    init_options = PhitexSettings,
    settings = { phitex = PhitexSettings },
    name = "phitex",
    cmd = { "phitex", "watch", "--lsp" },
    -- (a project is phitex.toml's folder, else the file's own: a TeX
    -- project often sits in a folder of a larger git repository)
    root_dir = vim.fs.root(buf, { "phitex.toml" }) or vim.fs.dirname(vim.api.nvim_buf_get_name(buf)),
    -- init_options = { main = "paper.tex" },
    handlers = {
      ["phitex/status"] = function(_, s, ctx)
        status[ctx.client_id] = s
        vim.cmd.redrawstatus()
      end,
    },
    on_exit = function(code, signal, client_id)
      status[client_id] = nil
      -- (an exit not asked for: said, with how to start it again)
      if code ~= 0 or signal ~= 0 then
        vim.schedule(function() vim.notify(string.format("PhiTeX: phitex watch exited (code %d). :PhiTeXRestart starts it again.", code), vim.log.levels.ERROR) end)
      end
    end,
  }, { bufnr = buf })
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

vim.api.nvim_create_user_command("PhiTeXViewer", function() exec("phitex.openViewer") end, { desc = "PhiTeX: open the pages in a browser" })
vim.api.nvim_create_user_command("PhiTeXStop", function() exec("phitex.stop") end, { desc = "PhiTeX: stop the watch" })
vim.api.nvim_create_user_command("PhiTeXRebuild", function() exec("phitex.rebuild") end, { desc = "PhiTeX: build again from scratch" })
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
