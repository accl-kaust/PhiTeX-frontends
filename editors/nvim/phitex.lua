-- PhiTeX's live preview in Neovim (0.11): `phitex watch --lsp` as the
-- language server of TeX files. The editor's buffer is built as you type,
-- TeX's errors are diagnostics, a double-click on a page opens its source
-- here (window/showDocument), and the cursor's words are marked on the
-- page (phitex/cursor, sent 150 ms after the cursor stops). The pages are
-- in a browser tab the watch serves (<leader>lv opens it).
--
-- Put this file in your config (e.g. ~/.config/nvim/plugin/phitex.lua);
-- `phitex` must be on PATH. A project with several .tex files names its
-- main one in phitex.toml (`main = "paper.tex"`) or in init_options.

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "tex", "plaintex", "bib" },
  callback = function(ev)
    local id = vim.lsp.start({
      name = "phitex",
      cmd = { "phitex", "watch", "--lsp" },
      root_dir = vim.fs.root(ev.buf, { "phitex.toml", ".git" }) or vim.fn.getcwd(),
      -- init_options = { main = "paper.tex" },
    })
    local timer = vim.uv.new_timer()
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
      buffer = ev.buf,
      callback = function()
        timer:stop()
        timer:start(150, 0, vim.schedule_wrap(function()
          local c = vim.lsp.get_client_by_id(id)
          if c and vim.api.nvim_get_current_buf() == ev.buf then
            c:notify("phitex/cursor", vim.lsp.util.make_position_params(0, "utf-16"))
          end
        end))
      end,
    })
    vim.keymap.set("n", "<leader>lv", function()
      vim.lsp.get_client_by_id(id):exec_cmd({ title = "viewer", command = "phitex.openViewer" })
    end, { buffer = ev.buf, desc = "PhiTeX: open the pages" })
  end,
})
