-- apps/editors/nvim/phitex.lua's handling of a new user's paths (test/editors/run-ux.sh):
-- a buffer read again from disk (:e!) is built as it now is; a watch attached to shows its
-- real state at once, and its end starts one here; :PhiTeXDoctor's report. PROJECT,
-- PHITEX_NVIM_CONFIG; each line "ok NAME" or "FAIL NAME: why"; exit 1 on a failure.
local failed = false
local function check(name, ok, why)
  io.stdout:write("\n" .. (ok and ("ok " .. name) or ("FAIL " .. name .. ": " .. tostring(why))) .. "\n")
  if not ok then failed = true end
end
local notes = {}
local notify = vim.notify
vim.notify = function(m, ...) table.insert(notes, m) return notify(m, ...) end
vim.cmd("filetype on")
dofile(vim.env.PHITEX_NVIM_CONFIG)
local project = vim.env.PROJECT
local main = project .. "/main.tex"
local function clients() return vim.lsp.get_clients({ name = "phitex" }) end
local function said(p) for _, n in ipairs(notes) do if n:find(p, 1, true) then return n end end end

-- (a watch in a "terminal": attached to, its state shown before any keystroke)
local watch = vim.fn.jobstart({ "phitex", "watch", "--no-open", "main.tex" }, { cwd = project, env = { BROWSER = "true" } })
vim.wait(60000, function()
  local r = vim.system({ "phitex", "session", "list", "--json" }, { text = true, cwd = project }):wait()
  return (r.stdout or ""):find("main.tex", 1, true) ~= nil
end, 300)
vim.wait(60000, function()
  local r = vim.system({ "phitex", "session", "status", "--json" }, { text = true, cwd = project }):wait()
  return (r.stdout or ""):find('"build":1', 1, true) ~= nil
end, 300)
vim.cmd("edit " .. main)
local buf = vim.api.nvim_get_current_buf()
check("attached to the terminal's watch", vim.wait(30000, function() return said("attached to the watch") ~= nil end, 100), table.concat(notes, " | "))
check("its state at once, not 'starting'", vim.wait(5000, function() return PhitexStatus():match("ms") ~= nil end, 50), PhitexStatus())

-- (:e! after an edit: the problem goes with the text)
vim.api.nvim_buf_set_lines(buf, 2, 3, false, { "Hello \\undefinedmacrohere world." })
check("an error typed is a diagnostic", vim.wait(60000, function() return #vim.diagnostic.get(buf) > 0 end, 100))
vim.cmd("e!")
check(":e! clears the error and the status",
  vim.wait(30000, function() return #vim.diagnostic.get(buf) == 0 and not PhitexStatus():match("✗") end, 100),
  PhitexStatus() .. " " .. #vim.diagnostic.get(buf))

-- (the terminal's watch ends: one started here, said so, never "it keeps running")
local pid = vim.fn.jobpid(watch)
vim.fn.jobstop(watch)
check("its end is said", vim.wait(30000, function() return said("the watch in the terminal ended; starting one here") ~= nil end, 100),
  table.concat(notes, " | ") .. string.format(" [watch alive %s, clients %d, stopped %s]", tostring(vim.uv.kill(pid, 0) == 0),
    #clients(), tostring(clients()[1] and clients()[1]:is_stopped())))
check("never 'keeps running where it was started'", not said("keeps running"), table.concat(notes, " | "))
check("a watch is started here", vim.wait(60000, function()
  local c = vim.lsp.get_clients({ bufnr = buf, name = "phitex" })[1]
  return c ~= nil and PhitexStatus():match("ms") ~= nil
end, 200), PhitexStatus())

-- (:PhiTeXDoctor: the report, its issue link last, copied by y)
vim.cmd("PhiTeXDoctor")
local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
local all = table.concat(lines, "\n")
check("the doctor names the plugin and the program", all:find("phitex.lua", 1, true) and all:find("editor protocol", 1, true), all)
check("the doctor ends with the issue link", all:find("https://github.com/accl-kaust/PhiTeX/issues/new/choose", 1, true), all)
check("the doctor holds no document text", not all:find("Hello", 1, true), all)
vim.api.nvim_feedkeys("y", "x", false)
check("y copies the report", vim.fn.getreg('"'):find("PhiTeX doctor", 1, true) ~= nil, vim.fn.getreg('"'))
vim.cmd("close")

vim.cmd("silent %bwipeout!")
vim.wait(20000, function() return #clients() == 0 end, 100)
vim.cmd(failed and "cquit 1" or "qa!")
