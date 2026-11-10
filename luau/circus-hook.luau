--!strict
export type Installer = (addEventHandler: (handler: any) -> ()) -> ()

export type Report = {
	failure: string?,
}

export type ArmOptions = {
	-- `circus/state`, not the package root: the root omits addEventHandler.
	circusState: ModuleScript,
	install: Installer,
	-- Yielding observers must follow attribution and other synchronous readers.
	installLast: boolean?,
	report: Report,
	runtimeClass: any,
}

type ArmedEntry = {
	installed: { [any]: boolean },
	options: ArmOptions,
}

local module = {}

local armedEntries: { [Report]: ArmedEntry } = {}
local patchedRuntimeClasses: { [any]: boolean } = setmetatable({}, { __mode = "k" }) :: any

-- Through the runtime: only its own registry's list is dispatched.
local function serve(report: Report, entry: ArmedEntry, runtime: any)
	if entry.installed[runtime] then
		return
	end

	entry.installed[runtime] = true

	local ok, err = pcall(function()
		local circusState = runtime:requireInternalModule(entry.options.circusState)
		local addEventHandler = circusState.addEventHandler
		assert(
			typeof(addEventHandler) == "function",
			"jest-circus circus/state exposes no addEventHandler"
		)

		entry.options.install(addEventHandler)
	end)

	if not ok and report.failure == nil then
		report.failure = tostring(err)
	end
end

local function installInto(runtime: any)
	for report, entry in armedEntries do
		if not entry.options.installLast then
			serve(report, entry, runtime)
		end
	end
	for report, entry in armedEntries do
		if entry.options.installLast then
			serve(report, entry, runtime)
		end
	end
end

-- Left patched: re-patching per run would restore a stale wrapper.
local function patchRuntimeClass(runtimeClass: any)
	if patchedRuntimeClasses[runtimeClass] then
		return
	end

	local original = runtimeClass.setGlobalsForRuntime
	assert(typeof(original) == "function", "JestRuntime exposes no setGlobalsForRuntime")
	patchedRuntimeClasses[runtimeClass] = true

	runtimeClass.setGlobalsForRuntime = function(self: any, ...: any)
		original(self, ...)
		installInto(self)
	end
end

function module.arm(options: ArmOptions)
	patchRuntimeClass(options.runtimeClass)

	armedEntries[options.report] = {
		installed = setmetatable({}, { __mode = "k" }) :: any,
		options = options,
	}
end

function module.disarm(report: Report)
	armedEntries[report] = nil
end

return module
