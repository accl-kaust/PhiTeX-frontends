-- PhiTeX for plugin managers that put apps/editors/nvim on the runtimepath
-- (vim-plug's `rtp`, packer's `rtp`, a native package): Neovim sources this
-- at startup, and it runs ../phitex.lua, the plugin itself.
local here = debug.getinfo(1, "S").source:sub(2):match("^(.*)[/\\]plugin[/\\][^/\\]*$")
dofile(here .. "/phitex.lua")
