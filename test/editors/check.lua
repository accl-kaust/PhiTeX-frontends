-- editors/nvim/phitex.lua against the phitex being released (test/editors/run.sh):
-- PROJECT, PROBE, PHITEX_NVIM_CONFIG; each line "ok NAME" or "FAIL NAME: why"; exit 1 on a failure.
local failed = false
local function check(name, ok, why)
  io.stdout:write((ok and ("ok " .. name) or ("FAIL " .. name .. ": " .. tostring(why))) .. "\n")
  if not ok then failed = true end
end
local log = {}
vim.lsp.handlers["window/logMessage"] = function(_, m) table.insert(log, m.message) end
vim.cmd("filetype on")
dofile(vim.env.PHITEX_NVIM_CONFIG)
local project = vim.env.PROJECT
local child = project .. "/chapters/ch1.tex"
vim.cmd("edit " .. child)
local buf = vim.api.nvim_get_current_buf()
local function c() return vim.lsp.get_clients({ name = "phitex" }) end
local function has(p) for _, l in ipairs(log) do if l:find(p) then return l end end end
check("the watch starts", vim.wait(30000, function() return #c() > 0 end, 100))
check("the main file is built, not the child", vim.wait(120000, function() return has("main%.tex → main%.pdf") end, 100), table.concat(log, " | "))
vim.wait(120000, function() return PhitexStatus():match("ms") ~= nil end, 200)
local url = (has("http://127%.0%.0%.1:%d+/%x+/") or ""):match("http://127%.0%.0%.1:%d+/%x+/")
check("the viewer's address is logged", url, table.concat(log, " | "))
vim.api.nvim_buf_set_text(buf, 0, 0, 0, 0, { "\\undefinedmacrohere " })
check("an error in the child is its diagnostic", vim.wait(60000, function() return #vim.diagnostic.get(buf) > 0 end, 100))
vim.api.nvim_buf_set_text(buf, 0, 0, 0, 20, { "" })
vim.wait(60000, function() return #vim.diagnostic.get(buf) == 0 end, 100)
if url then
  local done, code = false, nil
  vim.fn.jobstart({ "node", vim.env.PROBE, url, "follow", "30000" }, { on_exit = function(_, x) done, code = true, x end })
  vim.wait(1000, function() return false end, 50)
  vim.api.nvim_win_set_cursor(0, { 1, 3 })
  vim.api.nvim_exec_autocmds("CursorMoved", { buffer = buf })
  vim.wait(40000, function() return done end, 100)
  check("the cursor is shown on the pages (forward search)", code == 0, code)
  vim.cmd("edit " .. project .. "/main.tex")
  vim.fn.system({ "node", vim.env.PROBE, url, "source", "chapters/ch1.tex", "1" })
  check("a place on the pages opens in the editor (inverse search)",
    vim.wait(30000, function() return vim.api.nvim_buf_get_name(0) == child end, 100), vim.api.nvim_buf_get_name(0))
end
vim.cmd("edit " .. project .. "/main.tex")
vim.wait(5000, function() return false end, 100)
check("the main file opened later uses the same watch", #c() == 1, #c())
vim.cmd("silent %bwipeout!")
check("the watch stops with its last buffer", vim.wait(20000, function() return #c() == 0 end, 100))
vim.cmd(failed and "cquit 1" or "qa!")
