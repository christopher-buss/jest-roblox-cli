-- multi-byte text: columns are bytes, not characters — 日本語 ✓
local greeting = "héllo wörld"
local emoji = "🎉 party" -- 🎉 in a comment
local cjk = [[漢字
仮名]]
local interp = `名前: {greeting} 😀 {emoji}`
local t = { ["ключ"] = "значение", x = "ñ" }
--[[ block with ünïcödé ]] local after = 1
return greeting, emoji, cjk, interp, t, after
