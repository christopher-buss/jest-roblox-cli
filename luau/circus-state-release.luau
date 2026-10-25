--!strict
local InstanceResolver = require("./instance-resolver")

local module = {}

local patchedRuntimeClasses: { [any]: boolean } = setmetatable({}, { __mode = "k" }) :: any

local function findCircusTypes(jestModule: ModuleScript): Instance?
	local circusModule =
		InstanceResolver.findSiblingPackage(jestModule, "JestCircus", "jest-circus")
	return if circusModule then InstanceResolver.findCircusModule(circusModule, "types") else nil
end

function module.patch(jestModule: ModuleScript)
	local circusTypes = findCircusTypes(jestModule)
	local runtimeModule =
		InstanceResolver.findSiblingPackage(jestModule, "JestRuntime", "jest-runtime")
	if not circusTypes or not runtimeModule then
		return
	end

	local Runtime = (require :: any)(runtimeModule)
	if patchedRuntimeClasses[Runtime] then
		return
	end

	patchedRuntimeClasses[Runtime] = true
	local originalTeardown = Runtime.teardown
	-- Couples to jest-runtime's `_internalModuleRegistry` (keyed by
	-- ModuleScript) and jest-circus `circus/types.STATE_SYM`.
	Runtime.teardown = function(self: any, ...: any): ...any
		local registry = self._internalModuleRegistry
		local entry = if registry then registry:get(circusTypes) else nil
		if entry then
			local stateSymbol = entry.exports.STATE_SYM
			assert(
				stateSymbol ~= nil,
				"jest-circus circus/types exports no STATE_SYM; Jest internals changed"
			)
			_G[stateSymbol] = nil
		end

		return originalTeardown(self, ...)
	end
end

return module
