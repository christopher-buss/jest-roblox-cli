--!strict
--[[
	Runtime injection of `jest.config` ModuleScripts, as the per-config hooks
	`Runner.runProjects` calls.

	Studio + multi-project does NOT write `jest.config.luau` into the user's
	source tree — the configs travel in the run payload and are materialized
	into DataModel ModuleScripts just before Jest discovery runs, then
	destroyed again.

	Whoever runs the configs owns the injection. The stub's source reads the
	config out of `_G`, and `_G` is per-Luau-VM: a stub the run-mode
	coordinator created would read an empty `_G` when Jest requires it inside
	an actor host's VM. So the coordinator injects for a sequential run and
	each host injects for its own slice, both through this module.
]]
local HttpService = game:GetService("HttpService")

local module = {}

export type Hooks = {
	afterConfig: (cfg: any, index: number) -> (),
	beforeConfig: (cfg: any, index: number) -> (),
}

local function findInstance(path: string): Instance
	local parts = string.split(path, "/")
	local current: any = game:FindService(parts[1])
	assert(current, "service not found: " .. parts[1])
	for index = 2, #parts do
		current = current:FindFirstChild(parts[index])
		assert(current, "missing segment '" .. parts[index] .. "' in " .. path)
	end

	return current
end

--[[
	Build the inject/cleanup hooks for one run of `Runner.runProjects`, plus the
	belt-and-braces teardown to call once the run returns.

	`runtimeStubMounts[index]` is parallel to the configs the caller passes to
	`runProjects`: the DataModel paths that config's stubs go under, already
	filtered by the CLI to exclude mounts where Rojo syncs a user-authored
	`jest.config.luau`. We must iterate that filtered list rather than
	`cfg.projects`, or we would inject over the user's canonical config.
]]
function module.create(runtimeStubMounts: { { string } }): (Hooks, () -> ())
	-- The session-UUID `_G` key keeps each Run Mode invocation isolated
	-- against re-entrancy (the assert below fails loud if state from a prior
	-- run somehow persisted).
	local sessionKey = "__JEST_ROBLOX_RT_" .. HttpService:GenerateGUID(false):gsub("-", "")
	assert(_G[sessionKey] == nil, "Session key collision — re-entrant run detected")
	_G[sessionKey] = { configs = {} }

	-- Per-config record of injected ModuleScripts so cleanup after each
	-- config's Jest invocation can destroy exactly the stubs that config
	-- created. Per-config (rather than upfront-all) avoids the nested-project
	-- contamination path where configs at e.g. `ReplicatedStorage` and
	-- `ReplicatedStorage/Foo` would both have stubs in DataModel
	-- simultaneously and Jest's parent-traversal could resolve the wrong one.
	local injectedPerConfig: { [number]: { Instance } } = {}

	local function injectStubsForConfig(cfg: any, configIndex: number, injectionPaths: { string })
		local sessionTable = _G[sessionKey]
		sessionTable.configs[configIndex] = cfg
		-- Register the slot BEFORE parenting any stub. If a later mount
		-- throws (findInstance miss, structural collision), the partially-
		-- parented stubs are already tracked so cleanup can find and destroy
		-- them. Without this, an early stub would linger in DataModel.
		local injected: { Instance } = {}
		injectedPerConfig[configIndex] = injected

		for _, projectPath in injectionPaths do
			local leaf = findInstance(projectPath)
			assert(
				leaf:FindFirstChild("jest.config") == nil,
				"Structural collision: jest.config already exists under "
					.. projectPath
					.. ". This may be a user-authored config not declared as a string entry, "
					.. "a rojo tree mapping, or a model-file mount."
			)
			local stub = Instance.new("ModuleScript")
			stub.Name = "jest.config"
			stub.Source = string.format('return _G["%s"].configs[%d]', sessionKey, configIndex)
			stub.Parent = leaf
			-- Record immediately after parenting so a subsequent mount's
			-- failure does not strand this one.
			table.insert(injected, stub)
		end
	end

	local function cleanupStubsForConfig(configIndex: number)
		local injected = injectedPerConfig[configIndex]
		if injected ~= nil then
			for _, inst in injected do
				pcall(function()
					inst:Destroy()
				end)
			end

			injectedPerConfig[configIndex] = nil
		end

		local sessionTable = _G[sessionKey]
		if sessionTable ~= nil then
			sessionTable.configs[configIndex] = nil
		end
	end

	local function cleanupAll()
		for index in injectedPerConfig do
			cleanupStubsForConfig(index)
		end

		_G[sessionKey] = nil
	end

	local hooks: Hooks = {
		beforeConfig = function(cfg: any, index: number)
			injectStubsForConfig(cfg, index, runtimeStubMounts[index] or {})
		end,
		afterConfig = function(_cfg: any, index: number)
			cleanupStubsForConfig(index)
		end,
	}

	return hooks, cleanupAll
end

return module
