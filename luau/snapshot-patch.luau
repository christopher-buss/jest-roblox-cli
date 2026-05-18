--!strict
local CoreScriptSyncService = require("./mock/CoreScriptSyncService")
local InstanceResolver = require("./instance-resolver")

local module = {}

function module.createMockGetDataModelService(snapshotWrites: { [string]: string })
	local FileSystemService = require("./mock/FileSystemService")(snapshotWrites)

	return function(service: string): any
		if service == "FileSystemService" then
			return FileSystemService
		elseif service == "CoreScriptSyncService" then
			return CoreScriptSyncService
		end

		local success, result = pcall(function()
			local service_ = game:GetService(service)
			local _ = service_.Name
			return service_
		end)

		return if success then result else nil
	end
end

export type PatchState = {
	robloxSharedExports: any,
	originalGetDataModelService: any,
	Runtime: any,
	originalRequireInternalModule: any,
}

function module.patch(jestModule: ModuleScript, snapshotWrites: { [string]: string }): PatchState?
	local mockGetDataModelService = module.createMockGetDataModelService(snapshotWrites)

	local robloxSharedInstance = InstanceResolver.findRobloxShared(jestModule)
	if not robloxSharedInstance then
		warn("Could not find RobloxShared; snapshot support unavailable")
		return nil
	end

	local robloxSharedExports = (require :: any)(robloxSharedInstance)
	local originalGetDataModelService = robloxSharedExports.getDataModelService
	robloxSharedExports.getDataModelService = mockGetDataModelService

	-- Snapshot the partial state immediately so any subsequent throw can
	-- be rolled back. Without this, workspace mode (where multiple patch
	-- cycles share the same RobloxShared module) would leak the mock if
	-- the JestRuntime acquisition below threw — the next package's patch
	-- would then save the leaked mock as "original".
	local partialState: PatchState = {
		robloxSharedExports = robloxSharedExports,
		originalGetDataModelService = originalGetDataModelService,
		Runtime = nil,
		originalRequireInternalModule = nil,
	}

	local ok, err = pcall(function()
		local getDataModelServiceChild = robloxSharedInstance:FindFirstChild("getDataModelService")

		local jestRuntimeModule = InstanceResolver.findSiblingPackage(jestModule, "JestRuntime", "jest-runtime")
		if not jestRuntimeModule then
			warn("Could not find JestRuntime; snapshot interception unavailable")
			return
		end

		local Runtime = (require :: any)(jestRuntimeModule)
		local originalRequireInternalModule = Runtime.requireInternalModule

		Runtime.requireInternalModule = function(self: any, from: any, to: any, ...): any
			local target = if to ~= nil then to else from
			if getDataModelServiceChild and typeof(target) == "Instance" and target == getDataModelServiceChild then
				return mockGetDataModelService
			end

			return originalRequireInternalModule(self, from, to, ...)
		end

		partialState.Runtime = Runtime
		partialState.originalRequireInternalModule = originalRequireInternalModule
	end)

	if not ok then
		module.unpatch(partialState)
		error(err, 0)
	end

	return partialState
end

function module.unpatch(state: PatchState?)
	if not state then
		return
	end

	if state.robloxSharedExports and state.originalGetDataModelService then
		state.robloxSharedExports.getDataModelService = state.originalGetDataModelService
	end

	if state.Runtime and state.originalRequireInternalModule then
		state.Runtime.requireInternalModule = state.originalRequireInternalModule
	end
end

return module
