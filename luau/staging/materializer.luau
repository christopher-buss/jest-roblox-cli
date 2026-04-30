--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local StarterPlayer = game:GetService("StarterPlayer")

local module = {}

local function cloneInto(source: Instance, dest: Instance)
	for _, child in source:GetChildren() do
		local existing = dest:FindFirstChild(child.Name)
		if
			existing
			and (existing:IsA("Folder") or existing:IsA("Model"))
			and (child:IsA("Folder") or child:IsA("Model"))
		then
			cloneInto(child, existing)
		else
			local cloned = child:Clone()
			cloned.Parent = dest
		end
	end
end

function module.materialize(pkgName: string)
	local stage = ServerStorage:FindFirstChild("__pkg_stage")
	assert(stage, "ServerStorage.__pkg_stage missing")

	local staged = stage:FindFirstChild(pkgName)
	assert(staged, "no stage for " .. pkgName)

	if staged:IsA("ModuleScript") then
		local cloned = staged:Clone()
		cloned.Parent = ReplicatedStorage
		return
	end

	for _, stagedSvc in staged:GetChildren() do
		local svcName = stagedSvc.Name
		if svcName == "StarterPlayer" then
			for _, stagedSub in stagedSvc:GetChildren() do
				local liveSub = StarterPlayer:FindFirstChild(stagedSub.Name)
				if liveSub then
					cloneInto(stagedSub, liveSub)
				end
			end
		else
			local liveSvc = game:FindFirstChild(svcName)
			if liveSvc then
				cloneInto(stagedSvc, liveSvc)
			end
		end
	end
end

function module.collectJestConfigs(): { Instance }
	local configs: { Instance } = {}
	local seen: { [Instance]: boolean } = {}

	local function visit(root: Instance)
		for _, desc in root:GetDescendants() do
			if desc:IsA("ModuleScript") and desc.Name == "jest.config" and not seen[desc] then
				seen[desc] = true
				table.insert(configs, desc)
			end
		end
	end

	visit(ReplicatedStorage)
	visit(game:GetService("ServerScriptService"))
	visit(game:GetService("ServerStorage"))

	return configs
end

return module
