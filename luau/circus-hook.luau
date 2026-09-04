--!strict
-- The one way into jest-circus's per-test-file dispatch list.
--
-- Jest rebuilds the module registry for every test file, so circus's
-- module-scope `eventHandlers` list is a different list in every file and a
-- handler registered once before `Jest.runCLI` is in none of them. The only
-- point where a file's list exists and the runtime is reachable is
-- `JestRuntime.setGlobalsForRuntime` — the single call circus's per-file
-- `initialize` makes back into the runtime, fired once that file's registry
-- already holds the circus state module.
--
-- Consumers arm rather than install, because at arm time there is no registry
-- to install into: arming only names the consumers the per-file hook serves
-- from then on. The patch outlives the run that installed it, which is why
-- silence has to be asked for — see `disarm`.

--[=[
	What one consumer does with a test file's dispatch list.

	Called once per test file per armed consumer, from inside that file's own
	module registry.
]=]
export type Installer = (addEventHandler: (handler: any) -> ()) -> ()

--[=[
	One armed consumer's standing state.

	`failure` is the first install that did not take. It is reported as a field
	rather than thrown because the install happens inside jest's own per-file
	setup, where a throw fails that one test file instead of the run; the
	consumer reads it back afterwards and decides what a failed install means
	for it.
]=]
export type Report = {
	failure: string?,
}

export type ArmOptions = {
	--[=[
		jest-circus's `circus/state` ModuleScript, NOT the package root: the
		root re-exports `circus/init`, which forwards `setState`, `getState`,
		`resetState`, `run` and the test globals but not `addEventHandler`.
	]=]
	circusState: ModuleScript,
	install: Installer,
	report: Report,
	-- The shared JestRuntime class table, whose `setGlobalsForRuntime` is the
	-- per-test-file hook point.
	runtimeClass: any,
}

type ArmedEntry = {
	-- Runtimes already served, weak-keyed so a finished test file's runtime
	-- stays collectable through a run of any length.
	installed: { [any]: boolean },
	options: ArmOptions,
}

local module = {}

-- The consumers the per-file hook serves, keyed by the report each writes its
-- failure into. Module scope because the patch below outlives the run that
-- installed it.
local armedEntries: { [Report]: ArmedEntry } = {}
local patchedRuntimeClasses: { [any]: boolean } = setmetatable({}, { __mode = "k" }) :: any

-- Serve one consumer against this runtime's own circus registry. The state
-- module is asked for through the runtime, not required directly:
-- `requireInternalModule` answers from the registry this test file dispatches
-- through, which is the only list `addEventHandler` can usefully append to.
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
		serve(report, entry, runtime)
	end
end

-- Patched on the shared class table, the way setup-timing patches
-- `requireModule`, and left patched: the wrapper is inert while nothing is
-- armed, and re-patching per run would freeze a previous wrapper as the
-- restoration target.
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

--[=[
	Serve `options.install` from every test file of the run that is about to
	start.

	Nothing is installed here — there is no registry to install into yet.

	@param options -- The consumer, the circus state module, and the runtime
		class to patch.
]=]
function module.arm(options: ArmOptions)
	patchRuntimeClass(options.runtimeClass)

	armedEntries[options.report] = {
		installed = setmetatable({}, { __mode = "k" }) :: any,
		options = options,
	}
end

--[=[
	Stop serving one consumer, so a run that wants nothing from it gets
	nothing.

	The patch outlives the run that armed it, so without this the next run's
	test files would keep filling the last run's sink.

	@param report -- The report handed to `arm`.
]=]
function module.disarm(report: Report)
	armedEntries[report] = nil
end

return module
