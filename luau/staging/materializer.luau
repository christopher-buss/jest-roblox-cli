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

-- Set on a package's stage root by the synthesizer when that package's rojo
-- project declares `emitLegacyScripts: false`.
local RUN_CONTEXT_ATTRIBUTE = "JestRunContextScripts"

-- A `RunContext = Server` script runs wherever it sits in the DataModel, so the
-- staged copy would run at place load — before any package is materialized, and
-- again once it is. The place is therefore always built with legacy script
-- emission, which parks the staged copies inert under ServerStorage, and the
-- run context the package asked for is restored here, on the clone, before it
-- is parented into a live service.
--
-- A LocalScript cannot be restored the same way: `RunContext = Client` needs a
-- Script, and an Instance's ClassName is fixed. Nothing runs a client script in
-- a headless session anyway, so the gap costs nothing in practice.
local function restoreOne(instance: Instance)
	if instance:IsA("Script") and instance.RunContext == Enum.RunContext.Legacy then
		-- Guarded: a runtime that refuses the write leaves the script legacy,
		-- which is how it behaved before the run context was restored at all.
		pcall(function()
			instance.RunContext = Enum.RunContext.Server
		end)
	end
end

-- One pass, because `GetDescendants` is already the whole subtree. Recursing
-- into each descendant as well visits a node once per chain of ancestors above
-- it — 2^depth times — which a game-sized package pays as the engine's
-- non-yielding script timeout before a single test runs.
local function restoreRunContext(root: Instance)
	restoreOne(root)
	for _, descendant in root:GetDescendants() do
		restoreOne(descendant)
	end
end

local function cloneInto(source: Instance, dest: Instance, runContextScripts: boolean)
	for _, child in source:GetChildren() do
		local existing = dest:FindFirstChild(child.Name)
		if
			existing
			and (existing:IsA("Folder") or existing:IsA("Model"))
			and (child:IsA("Folder") or child:IsA("Model"))
		then
			cloneInto(child, existing, runContextScripts)
		else
			local cloned = child:Clone()
			-- Before parenting: a script that enters a live service starts
			-- running, and it should start under the context it asked for.
			if runContextScripts then
				restoreRunContext(cloned)
			end

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

	local runContextScripts = staged:GetAttribute(RUN_CONTEXT_ATTRIBUTE) == true

	for _, stagedSvc in staged:GetChildren() do
		local svcName = stagedSvc.Name
		if svcName == "StarterPlayer" then
			for _, stagedSub in stagedSvc:GetChildren() do
				local liveSub = StarterPlayer:FindFirstChild(stagedSub.Name)
				if liveSub then
					cloneInto(stagedSub, liveSub, runContextScripts)
				end
			end
		else
			local liveSvc = game:FindFirstChild(svcName)
			if liveSvc then
				cloneInto(stagedSvc, liveSvc, runContextScripts)
			end
		end
	end
end

return module
