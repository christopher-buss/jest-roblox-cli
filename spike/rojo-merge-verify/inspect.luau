local fs = require("@lune/fs")
local roblox = require("@lune/roblox")

local function inspectFile(path: string)
	print("=== " .. path .. " ===")
	local bytes = fs.readFile(path)
	local game = roblox.deserializePlace(bytes)

	local rs = game:GetService("ReplicatedStorage")
	local common = rs:FindFirstChild("Common")
	if common == nil then
		print("MISSING: Common")
		return
	end

	print("Common children:")
	for _, child in common:GetChildren() do
		print("  - " .. child.Name .. " [" .. child.ClassName .. "]")
		if child:IsA("ModuleScript") or child:IsA("LuaSourceContainer") then
			local ok, src = pcall(function()
				return (child :: any).Source
			end)
			if ok and src ~= nil then
				print("      source: " .. tostring(src):gsub("\n", " | "))
			end
		end
		for _, grand in child:GetChildren() do
			print("      child: " .. grand.Name .. " [" .. grand.ClassName .. "]")
		end
	end
end

inspectFile("merge.rbxl")
print("")
local ok = pcall(inspectFile, "merge-collision.rbxl")
if not ok then
	print("(merge-collision.rbxl not built)")
end
