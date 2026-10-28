-- editors/nvim/phitex.lua against phitex watch --lsp, headless (Neovim 0.11+):
--   PHITEX_NVIM_CONFIG=editors/nvim/phitex.lua DOC=/path/doc.tex nvim --clean --headless -c "luafile test/nvim-lsp.lua"
-- (phitex on PATH): the client attaches, an unsaved error is a diagnostic, its fix clears it.
dofile(vim.env.PHITEX_NVIM_CONFIG)
vim.cmd("edit " .. vim.env.DOC)
local buf = vim.api.nvim_get_current_buf()
local function wait_diag(pred, ms)
  return vim.wait(ms, function() return pred(vim.diagnostic.get(buf)) end, 100)
end
local attached = vim.wait(10000, function() return #vim.lsp.get_clients({ bufnr = buf, name = "phitex" }) > 0 end, 100)
print("filetype " .. vim.bo.filetype .. ", client attached: " .. tostring(attached))
-- (the first build makes the format: let it finish)
vim.wait(30000, function() return false end, 500)
local line = vim.fn.search("Some text") - 1
vim.api.nvim_buf_set_text(buf, line, 0, line, 0, { "\\undefinedmacro " })
local got = wait_diag(function(d) return #d > 0 end, 30000)
local d = vim.diagnostic.get(buf)[1]
print("unsaved error -> diagnostic: " .. tostring(got) .. (d and (" (line " .. (d.lnum + 1) .. ": " .. d.message:match("[^\n]*") .. ")") or ""))
vim.api.nvim_buf_set_text(buf, line, 0, line, 16, { "" })
local cleared = wait_diag(function(d) return #d == 0 end, 30000)
print("fixed -> cleared: " .. tostring(cleared))
vim.cmd("qa!")
