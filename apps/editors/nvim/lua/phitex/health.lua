-- :checkhealth phitex: PhiTeX's setup, as :PhiTeXDoctor shows it (phitex.lua's
-- PhitexDoctorFindings), in Neovim's health report.
local M = {}

function M.check()
  if type(PhitexDoctorFindings) ~= "function" then
    vim.health.start("PhiTeX")
    vim.health.error("phitex.lua is not loaded", { "put apps/editors/nvim on the runtimepath, or dofile its phitex.lua" })
    return
  end
  for _, s in ipairs(PhitexDoctorFindings()) do
    vim.health.start("PhiTeX: " .. s.title)
    for _, i in ipairs(s.items) do
      if i.ok == true then vim.health.ok(i.text)
      elseif i.ok == false then vim.health.error(i.text, i.fix and { i.fix } or nil)
      else vim.health.info(i.text) end
    end
  end
end

return M
