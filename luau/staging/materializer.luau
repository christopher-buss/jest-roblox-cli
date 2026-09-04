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

-- Set on a marker by the shared-pool staging pass, naming the entry under
-- ServerStorage.__pkg_stage.__shared that the marker stands for.
local SHARED_POOL_ATTRIBUTE = "JestSharedPoolKey"
local SHARED_POOL_NAME = "__shared"

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

-- Whether the DataModel already holds this instance. A live service and
-- everything under it, the stage, and the pool beside it are all in it; a clone
-- the plan has made is not, until the step that lands it runs. Which side an
-- instance is on decides everything the plan does with it: what is live is
-- cloned and earns a step, what is not is moved and rides its ancestor's.
local function isLive(instance: Instance): boolean
	return instance:IsDescendantOf(game)
end

-- The entry a marker stands for. The place holds one copy of a mount several
-- packages share, under `__shared`, and each package's stage holds a Folder
-- naming it instead of a copy of its own. Everything downstream reads the
-- entry rather than the marker: a pooled entry can be a ModuleScript, and a
-- Folder standing in for it would merge where the entry would collide, and
-- shadow the require where it landed.
local function pooledEntry(pool: Instance?, source: Instance): Instance?
	-- The nil test first: a stage with no pool has no markers either, and
	-- GetAttribute is the pricier of the two questions to ask per child.
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

-- What one planned clone does: land `clone`, whole, under a live `dest`. A
-- clone that lands inside another clone needs no step: its ancestor's step
-- takes it live along with everything else that ancestor holds.
--
-- The clone is made while planning rather than at step time, so a marker's own
-- children can be planned into the resolution the way they would be planned
-- into any other destination. Nothing live is touched by that: a clone has no
-- parent until its step runs, and a plan that reports a collision throws every
-- clone it made away. The abort path is what pays for it, and an abort already
-- costs a place upload and the cold boot behind it.
type Step = { clone: Instance, dest: Instance }
type Plan = {
	add: (children: { Instance }, dest: Instance) -> (),
	collisions: { string },
	steps: { Step },
}

-- Decides where every staged child lands, and builds the clone that lands
-- there, without putting any of it live. A clone that enters a live service
-- has its scripts already running, so a walk that gave up half way would leave
-- those behind for whatever ran next.
--
-- A name under one destination belongs to one instance. Two same-name children
-- merge only when both are containers, which is the one case where the staged
-- subtree can go on to be walked against the live one; anything else has no
-- merge rule. Parenting it anyway puts two children of one name side by side,
-- and every later FindFirstChild silently picks whichever was parented first,
-- including the ones the code under test makes.
--
-- The name a step claims is held against later steps too. A clone bound for a
-- live destination is not parented during the walk, so a second staged child
-- of that name would otherwise find the destination free and land beside the
-- first. What is held is the clone, not the staged source, so a later child of
-- that name merges into it under the same rule that merges into a live
-- container. A marker is what makes that reachable: what the pooled mount
-- built and what the marker declared beside it are planned into one
-- destination, and a name in both halves has to merge exactly as it would
-- inside a fresh clone.
local function newPlan(pool: Instance?): Plan
	local claimed: { [Instance]: { [string]: Instance } } = {}
	local collisions: { string } = {}
	local steps: { Step } = {}

	-- Declared ahead of `add` because the two call each other: a clone the plan
	-- lands is swept for the markers it carries, and each of those hands itself
	-- back to the plan.
	local resolveNestedMarkers: (root: Instance) -> ()

	local function add(children: { Instance }, dest: Instance)
		local held = claimed[dest]
		if held == nil then
			held = {}
			claimed[dest] = held
		end

		-- Asked once: nothing this walk does puts a destination into the
		-- DataModel, which only a step does, and every step runs after it.
		local destIsLive = isLive(dest)

		for _, child in children do
			-- Resolved before anything is decided, so a marker merges, clones
			-- and collides exactly as the mount it stands for would have.
			local entry = pooledEntry(pool, child)
			local source = entry or child
			-- The one instance already standing where this child would land: a
			-- clone a staged sibling claimed the name with, or a child the
			-- destination already holds. Never both — a name a child of the
			-- destination holds is merged into rather than claimed, so nothing
			-- is held for it.
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
				-- Both halves of a marker: what the pooled mount built, and
				-- the explicit children the marker declared beside it. One
				-- destination, so the one `held` table judges a name they both
				-- claim like any other pair.
				add(source:GetChildren(), occupied)
				if entry ~= nil then
					add(child:GetChildren(), occupied)
				end
			else
				-- A clone this plan made and has not landed moves into the
				-- destination rather than being cloned again: re-cloning a
				-- dependency tree is the cost the pool exists to avoid. A
				-- marker never moves — what it stands for is in the pool,
				-- which the DataModel holds.
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
					-- The marker's own children, into the resolution rather
					-- than beside it.
					add(child:GetChildren(), resolved)
				elseif not moved and pool ~= nil and not child:IsDescendantOf(pool) then
					-- Only the stage holds markers. A pooled entry is mounted
					-- from a `$path` and can hold none, and what moved is
					-- already inside the subtree the sweep that handed it over
					-- is walking.
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

	-- Markers below the top of a cloned subtree. A staged child is cloned whole
	-- once the plan gives it a landing site, so every marker inside it comes
	-- across as the Folder it was; the pass pools at any depth, and
	-- `rbxts_include.node_modules.@rbxts.services` is two levels down.
	--
	-- One pass, for the reason `restoreRunContext` gives: `GetDescendants` is
	-- already the whole subtree.
	--
	-- Each marker goes back through the plan, which is the whole point: a
	-- marker at this depth is judged by the rule a marker at the top of a stage
	-- is judged by, rather than by a second resolution that has no collision
	-- list to report to.
	--
	-- The snapshot is read as it was taken, which is what reaches a marker
	-- carried inside another marker's child: the move keeps it in the tree. One
	-- the plan resolved itself is in the snapshot too, and is not in the tree —
	-- `Destroy` takes the Parent off the whole subtree it removes.
	function resolveNestedMarkers(root: Instance)
		for _, descendant in root:GetDescendants() do
			-- The Parent read is the "still in the tree" half: `Destroy` takes
			-- the Parent off every instance in the subtree it removes.
			if descendant.Parent ~= nil and pooledEntry(pool, descendant) ~= nil then
				local host = descendant.Parent
				-- Out of the way before the plan looks: the marker stands
				-- exactly where its own resolution has to land.
				descendant.Parent = nil
				add({ descendant }, host)
				-- Whatever is left is whatever did not move: on the abort path,
				-- the children a collision stopped.
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
	local stage = ServerStorage:FindFirstChild("__pkg_stage")
	assert(stage, "ServerStorage.__pkg_stage missing")

	local staged = stage:FindFirstChild(pkgName)
	assert(staged, "no stage for " .. pkgName)

	local runContextScripts = staged:GetAttribute(RUN_CONTEXT_ATTRIBUTE) == true
	local pool = stage:FindFirstChild(SHARED_POOL_NAME)
	local plan = newPlan(pool)

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
		-- Before parenting: a script that enters a live service starts
		-- running, and it should start under the context it asked for. The
		-- plan has already resolved every marker inside the clone, so a script
		-- a pooled entry brought is restored with the rest.
		if runContextScripts then
			restoreRunContext(step.clone)
		end

		step.clone.Parent = step.dest
		table.insert(materialized, step.clone)
	end
end

return module
