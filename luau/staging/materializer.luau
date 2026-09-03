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

local function isContainer(instance: Instance): boolean
	return instance:IsA("Folder") or instance:IsA("Model")
end

type Step = { child: Instance, dest: Instance }
type Plan = {
	add: (children: { Instance }, dest: Instance) -> (),
	collisions: { string },
	steps: { Step },
}

-- Decides where every staged child lands without parenting any of it. A clone
-- that lands is live and its scripts are already running, so a walk that gave
-- up half way would leave those behind for whatever ran next.
--
-- A name under one destination belongs to one instance. Two same-name children
-- merge only when both are containers, which is the one case where the staged
-- subtree can go on to be walked against the live one; anything else has no
-- merge rule. Parenting it anyway puts two children of one name side by side,
-- and every later FindFirstChild silently picks whichever was parented first,
-- including the ones the code under test makes.
--
-- The name a step claims is held against later steps too. Nothing is parented
-- during the walk, so a second staged child of that name would otherwise find
-- the destination free and land beside the first.
local function newPlan(): Plan
	local claimed: { [Instance]: { [string]: Instance } } = {}
	local collisions: { string } = {}
	local steps: { Step } = {}

	local function add(children: { Instance }, dest: Instance)
		local held = claimed[dest]
		if held == nil then
			held = {}
			claimed[dest] = held
		end

		for _, child in children do
			local sibling = held[child.Name]
			local existing = dest:FindFirstChild(child.Name)

			local occupant: string? = nil
			if sibling ~= nil then
				-- A staged sibling claimed the name first. Its clone does not
				-- exist yet, so there is nothing to merge into.
				occupant = "staged " .. sibling.ClassName
			elseif existing ~= nil and not (isContainer(existing) and isContainer(child)) then
				occupant = "live " .. existing.ClassName
			end

			if occupant ~= nil then
				table.insert(
					collisions,
					string.format(
						"%s.%s: staged %s over %s",
						dest:GetFullName(),
						child.Name,
						child.ClassName,
						occupant
					)
				)
			elseif existing ~= nil then
				add(child:GetChildren(), existing)
			else
				held[child.Name] = child
				table.insert(steps, { child = child, dest = dest })
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
	local stage = ServerStorage:FindFirstChild("__pkg_stage")
	assert(stage, "ServerStorage.__pkg_stage missing")

	local staged = stage:FindFirstChild(pkgName)
	assert(staged, "no stage for " .. pkgName)

	local runContextScripts = staged:GetAttribute(RUN_CONTEXT_ATTRIBUTE) == true
	local plan = newPlan()

	if staged:IsA("ModuleScript") then
		-- A package whose whole stage is one module has no service layer to
		-- walk; the module itself is the staged child.
		plan.add({ staged }, ReplicatedStorage)
	else
		for _, stagedSvc in staged:GetChildren() do
			local svcName = stagedSvc.Name
			if svcName == "StarterPlayer" then
				for _, stagedSub in stagedSvc:GetChildren() do
					local liveSub = StarterPlayer:FindFirstChild(stagedSub.Name)
					if liveSub then
						plan.add(stagedSub:GetChildren(), liveSub)
					end
				end
			else
				local liveSvc = game:FindFirstChild(svcName)
				if liveSvc then
					plan.add(stagedSvc:GetChildren(), liveSvc)
				end
			end
		end
	end

	-- Every collision at once: a retry costs a place upload and the cold boot
	-- behind it, so reporting one at a time bills a round trip per collision.
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
		local cloned = step.child:Clone()
		-- Before parenting: a script that enters a live service starts
		-- running, and it should start under the context it asked for.
		if runContextScripts then
			restoreRunContext(cloned)
		end

		cloned.Parent = step.dest
		table.insert(materialized, cloned)
	end
end

return module
