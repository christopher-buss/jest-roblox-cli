--!strict
-- `_G` is per-VM: inject in the VM that runs the configs, or the stub
-- reads an empty `_G`.
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

-- `runtimeStubMounts` is parallel to the configs; iterate it, not
-- `cfg.projects`, or stubs land over user-authored configs.
function module.create(runtimeStubMounts: { { string } }): (Hooks, () -> ())
	-- Unique key per run: the assert below catches a persisted session.
	local sessionKey = "__JEST_ROBLOX_RT_" .. HttpService:GenerateGUID(false):gsub("-", "")
	assert(_G[sessionKey] == nil, "Session key collision: re-entrant run detected")
	_G[sessionKey] = { configs = {} }

	-- Per config: nested mounts with stubs present at once mislead Jest.
	local injectedPerConfig: { [number]: { Instance } } = {}

	local function injectStubsForConfig(cfg: any, configIndex: number, injectionPaths: { string })
		local sessionTable = _G[sessionKey]
		local mountConfigs = {}
		sessionTable.configs[configIndex] = mountConfigs
		-- Register the slot before parenting, so cleanup finds partial stubs.
		local injected: { Instance } = {}
		injectedPerConfig[configIndex] = injected

		for mountIndex, projectPath in injectionPaths do
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
			-- Jest sets rootDir on the required table in place, so a shared table
			-- would pin every mount to the first mount's rootDir.
			mountConfigs[mountIndex] = table.clone(cfg)
			stub.Source = string.format(
				'return _G["%s"].configs[%d][%d]',
				sessionKey,
				configIndex,
				mountIndex
			)
			stub.Parent = leaf
			-- Record right after parenting, so a later failure does not strand it.
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
