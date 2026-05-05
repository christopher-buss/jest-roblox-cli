--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local StarterPlayer = game:GetService("StarterPlayer")

local module = {}

-- Identity-tracked Instances we materialized in the current package's run.
-- Reset destroys these in reverse order, leaving mega-place root infra
-- (Test, DevPackages, etc.) untouched. Folder-merge collisions do NOT add
-- the merged-into folder to this list — only newly-cloned children do.
local materialized: { Instance } = {}

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
			table.insert(materialized, cloned)
		end
	end
end

function module.reset()
	for index = #materialized, 1, -1 do
		local instance = materialized[index]
		if instance and instance.Parent then
			instance:Destroy()
		end
	end
	table.clear(materialized)
end

function module.materialize(pkgName: string)
	local stage = ServerStorage:FindFirstChild("__pkg_stage")
	assert(stage, "ServerStorage.__pkg_stage missing")

	local staged = stage:FindFirstChild(pkgName)
	assert(staged, "no stage for " .. pkgName)

	if staged:IsA("ModuleScript") then
		local cloned = staged:Clone()
		cloned.Parent = ReplicatedStorage
		table.insert(materialized, cloned)
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

return module
