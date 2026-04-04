--!strict
local InstanceResolver = require("./instance-resolver")

local module = {}

export type PatchState = {
	Runtime: any,
	originalRequireModule: any,
	accumulatedSeconds: { value: number },
}

function module.patch(
	jestModule: ModuleScript,
	setupFiles: { Instance }?,
	setupFilesAfterEnv: { Instance }?
): PatchState?
	local setupSet: { [Instance]: boolean } = {}

	if setupFiles then
		for _, inst in setupFiles do
			setupSet[inst] = true
		end
	end

	if setupFilesAfterEnv then
		for _, inst in setupFilesAfterEnv do
			setupSet[inst] = true
		end
	end

	if not next(setupSet) then
		return nil
	end

	local jestRuntimeModule = InstanceResolver.findSiblingPackage(jestModule, "JestRuntime", "jest-runtime")
	if not jestRuntimeModule then
		warn("Could not find JestRuntime; setup timing unavailable")
		return nil
	end

	local Runtime = (require :: any)(jestRuntimeModule)
	local originalRequireModule = Runtime.requireModule
	local accumulated = { value = 0 }
	local insideSetupRequire = false

	Runtime.requireModule = function(self: any, moduleName: any, ...): any
		if not insideSetupRequire and typeof(moduleName) == "Instance" and setupSet[moduleName] then
			insideSetupRequire = true
			local t0 = os.clock()
			local results = table.pack(pcall(originalRequireModule, self, moduleName, ...))
			accumulated.value += os.clock() - t0
			insideSetupRequire = false

			if not results[1] then
				error(results[2], 0)
			end

			return table.unpack(results, 2, results.n)
		end

		return originalRequireModule(self, moduleName, ...)
	end

	return {
		Runtime = Runtime,
		originalRequireModule = originalRequireModule,
		accumulatedSeconds = accumulated,
	}
end

function module.unpatch(state: PatchState?)
	if not state then
		return
	end

	if state.Runtime and state.originalRequireModule then
		state.Runtime.requireModule = state.originalRequireModule
	end
end

function module.getSeconds(state: PatchState?): number
	if not state then
		return 0
	end

	return state.accumulatedSeconds.value
end

return module
