-- Neovim smoke test (CI: .github/workflows/editors.yml): the plugin loads as a
-- plugin manager loads it, without errors, and its commands exist.
--   nvim --headless -u NONE -l test/editors/nvim.lua
vim.opt.rtp:prepend(vim.fn.getcwd() .. "/apps/editors/nvim")
local ok, err = pcall(vim.cmd, "runtime! plugin/phitex.lua")
assert(ok, err)
for _, c in ipairs({ "PhiTeXInstall", "PhiTeXViewer", "PhiTeXStop", "PhiTeXRebuild", "PhiTeXRestart", "PhiTeXSavePdf", "PhiTeXCaches", "PhiTeXClearCache" }) do
  assert(vim.fn.exists(":" .. c) == 2, "no :" .. c)
end
print("phitex.lua loads on Neovim " .. tostring(vim.version()))
