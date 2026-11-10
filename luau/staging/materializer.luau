--!strict
local Lighting = game:GetService("Lighting")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local StagedPlace = require("../protocol").stagedPlace

local module = {}

local materialized: { Instance } = {}

local RUN_CONTEXT_ATTRIBUTE = StagedPlace.runContextAttribute
local SHARED_POOL_ATTRIBUTE = StagedPlace.sharedPoolAttribute
local SHARED_POOL_NAME = StagedPlace.sharedPoolName
local NESTED_PINNED_CLASSES: { [string]: { string } } = StagedPlace.nestedPinnedClasses

local function restoreOne(instance: Instance)
	if instance:IsA("Script") and instance.RunContext == Enum.RunContext.Legacy then
		-- Some runtimes refuse this write; the script then stays legacy.
		pcall(function()
			instance.RunContext = Enum.RunContext.Server
		end)
	end
end

local function restoreRunContext(root: Instance)
	restoreOne(root)
	for _, descendant in root:GetDescendants() do
		restoreOne(descendant)
	end
end

local function clearUndeclaredLighting()
	for _, child in Lighting:GetChildren() do
		child:Destroy()
	end
end

local function isContainer(instance: Instance): boolean
	return instance:IsA("Folder") or instance:IsA("Model")
end

local function isLive(instance: Instance): boolean
	return instance:IsDescendantOf(game)
end

local function pooledEntry(pool: Instance?, source: Instance): Instance?
	if pool == nil then
		return nil
	end

	local key = source:GetAttribute(SHARED_POOL_ATTRIBUTE)
	if typeof(key) ~= "string" then
		return nil
	end

	local entry = pool:FindFirstChild(key)
	assert(entry, "no pooled entry for " .. key)
	return entry
end

type Step = { clone: Instance, dest: Instance }
type Plan = {
	add: (children: { Instance }, dest: Instance) -> (),
	collisions: { string },
	steps: { Step },
}

local function newPlan(pool: Instance?): Plan
	local claimed: { [Instance]: { [string]: Instance } } = {}
	local collisions: { string } = {}
	local steps: { Step } = {}

	local resolveNestedMarkers: (root: Instance) -> ()

	local function add(children: { Instance }, dest: Instance)
		local held = claimed[dest]
		if held == nil then
			held = {}
			claimed[dest] = held
		end

		local destIsLive = isLive(dest)

		for _, child in children do
			local entry = pooledEntry(pool, child)
			local source = entry or child
			local occupied = held[child.Name] or dest:FindFirstChild(child.Name)

			if occupied ~= nil and not (isContainer(occupied) and isContainer(source)) then
				table.insert(
					collisions,
					string.format(
						"%s.%s: staged %s over %s%s",
						dest:GetFullName(),
						child.Name,
						source.ClassName,
						if isLive(occupied) then "live " else "staged ",
						occupied.ClassName
					)
				)
			elseif occupied ~= nil then
				add(source:GetChildren(), occupied)
				if entry ~= nil then
					add(child:GetChildren(), occupied)
				end
			else
				local moved = entry == nil and not isLive(child)
				local resolved
				if moved then
					resolved = child
				else
					resolved = source:Clone()
					resolved.Name = child.Name
				end

				held[child.Name] = resolved

				if entry ~= nil then
					add(child:GetChildren(), resolved)
				elseif not moved and pool ~= nil and not child:IsDescendantOf(pool) then
					resolveNestedMarkers(resolved)
				end

				if destIsLive then
					table.insert(steps, { clone = resolved, dest = dest })
				else
					resolved.Parent = dest
				end
			end
		end
	end

	function resolveNestedMarkers(root: Instance)
		for _, descendant in root:GetDescendants() do
			-- `Destroy` clears Parent on a removed subtree; skip those.
			if descendant.Parent ~= nil and pooledEntry(pool, descendant) ~= nil then
				local host = descendant.Parent
				-- Unparent first: the resolution lands where the marker stands.
				descendant.Parent = nil
				add({ descendant }, host)
				descendant:Destroy()
			end
		end
	end

	return { add = add, collisions = collisions, steps = steps }
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
	local stage = ServerStorage:FindFirstChild(StagedPlace.stageKey)
	assert(stage, "ServerStorage." .. StagedPlace.stageKey .. " missing")

	local staged = stage:FindFirstChild(pkgName)
	assert(staged, "no stage for " .. pkgName)

	clearUndeclaredLighting()

	local runContextScripts = staged:GetAttribute(RUN_CONTEXT_ATTRIBUTE) == true
	local pool = stage:FindFirstChild(SHARED_POOL_NAME)
	local plan = newPlan(pool)

	if staged:IsA("ModuleScript") then
		plan.add({ staged }, ReplicatedStorage)
	else
		for _, stagedSvc in staged:GetChildren() do
			local liveSvc = game:FindFirstChild(stagedSvc.Name)
			if liveSvc then
				local pinned = NESTED_PINNED_CLASSES[stagedSvc.Name] or {}
				local children = {}
				for _, stagedChild in stagedSvc:GetChildren() do
					local liveChild = if table.find(pinned, stagedChild.Name)
						then liveSvc:FindFirstChild(stagedChild.Name)
						else nil
					if liveChild then
						plan.add(stagedChild:GetChildren(), liveChild)
					else
						table.insert(children, stagedChild)
					end
				end
				plan.add(children, liveSvc)
			end
		end
	end

	if #plan.collisions > 0 then
		error(
			string.format(
				"materialize %s: staged instances collide, and only Folder/Model pairs merge:\n  %s",
				pkgName,
				table.concat(plan.collisions, "\n  ")
			),
			0
		)
	end

	for _, step in plan.steps do
		-- Before parenting: a script starts running once it is live.
		if runContextScripts then
			restoreRunContext(step.clone)
		end

		step.clone.Parent = step.dest
		table.insert(materialized, step.clone)
	end
end

return module
