--!strict
-- Per-test coverage hook. Installs a jest-circus event handler that snapshots
-- the runtime hit table on `test_start` and diffs it on `test_done`,
-- attributing the newly-covered statements to the test that just ran. The
-- test's identity (file + full name) is read from the Expect matcher state,
-- which jest sets per-file (`testPath`) and per-test (`currentTestName`).
--
-- The handler cannot be installed once per run. Circus keeps `eventHandlers` as
-- a module-scope list in `circus/combined.lua`, and jest rebuilds the module
-- registry for every test file (ADR-0002 Finding A), so each file dispatches
-- through its own list and a handler installed before `Jest.runCLI` is in none
-- of them. `arm` therefore installs from inside each file's registry, riding
-- the one call circus's per-file `initialize` makes back into the runtime.
--
-- `addEventHandler`, `getMatcherState`, and `getCoverage` are injected so the
-- orchestration is testable under lute without a real circus or Roblox
-- DataModel. The runner passes `_G.__jest_roblox_cov` as the coverage source.

local Attribution = require("./coverage-attribution")

type MatcherState = { currentTestName: string?, testPath: Instance? }
export type Record = { delta: any, testCaseId: string, testFilePath: string }

--[=[
	One armed run's attribution, filling as its test files run.

	`failure` is the first install that did not take. It is reported as a field
	rather than thrown because the install happens inside jest's own per-file
	setup, where a throw fails that one test file instead of the run; the run
	reads it back afterwards and fails as a whole.
]=]
export type Installation = {
	failure: string?,
	records: { Record },
}

--[=[
	What one run needs to install the hook into each of its test files.

	`circusState` is jest-circus's `circus/state` ModuleScript, NOT the package
	root: the root re-exports `circus/init`, which forwards `setState`,
	`getState`, `resetState`, `run` and the test globals but not
	`addEventHandler`. Resolving the root and calling `addEventHandler` on it
	calls nil.
]=]
export type ArmOptions = {
	circusState: ModuleScript,
	getCoverage: () -> any,
	getMatcherState: () -> MatcherState,
	-- The shared JestRuntime class table, whose `setGlobalsForRuntime` is the
	-- per-test-file hook point.
	runtimeClass: any,
}

type ArmedRun = {
	installation: Installation,
	-- Runtimes already hooked, weak-keyed so a finished test file's runtime
	-- stays collectable through a run of any length.
	installed: { [any]: boolean },
	options: ArmOptions,
}

local module = {}

-- The run currently asking for attribution, or nil when none is. Module scope
-- because the patch below outlives the run that installed it: both runners arm
-- immediately before `Jest.runCLI`, so the armed run is always the one whose
-- sink the hook should fill.
local armedRun: ArmedRun? = nil
local patchedRuntimeClasses: { [any]: boolean } = setmetatable({}, { __mode = "k" }) :: any

-- Service-rooted DataModel path (the `game` root, whose parent is nil, is
-- excluded), slash-joined to match the form jest-roblox-cli's source mapper
-- resolves.
local function dataModelPath(instance: Instance): string
	local parts: { string } = {}
	local current: Instance? = instance
	while current and current.Parent ~= nil do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end

	return table.concat(parts, "/")
end

--[=[
	Register the snapshot-and-diff handler on one circus dispatch list.

	`records` lets several installs share one accumulator, which is what a run
	spanning many test files needs: each file's registry gets its own handler,
	and all of them append to the run's single list.
]=]
function module.install(
	addEventHandler: (handler: any) -> (),
	getMatcherState: () -> MatcherState,
	getCoverage: () -> any,
	records: { Record }?
): { Record }
	local accumulated: { Record } = records or {}
	local before: any = nil

	-- Circus does not guard event handlers (a throw rejects the run's dispatch
	-- chain), so the whole body is pcall-wrapped: attribution is best-effort and
	-- must never break the coverage run it observes.
	addEventHandler(function(_self: any, event: { name: string })
		pcall(function()
			if event.name == "test_start" then
				before = Attribution.snapshot(getCoverage())
			elseif event.name == "test_done" then
				if before == nil then
					return
				end

				local delta = Attribution.diff(before, getCoverage())
				before = nil
				if next(delta) == nil then
					return
				end

				local state = getMatcherState()
				table.insert(accumulated, {
					delta = delta,
					testCaseId = state.currentTestName or "",
					testFilePath = if state.testPath then dataModelPath(state.testPath) else "",
				})
			end
		end)
	end)

	return accumulated
end

-- Put the hook in this runtime's own circus registry. The state module is
-- asked for through the runtime, not required directly: `requireInternalModule`
-- answers from the registry this test file dispatches through, which is the
-- only list `addEventHandler` can usefully append to.
local function installInto(runtime: any)
	local run = armedRun
	if run == nil or run.installed[runtime] then
		return
	end

	run.installed[runtime] = true

	local ok, err = pcall(function()
		local circusState = runtime:requireInternalModule(run.options.circusState)
		local addEventHandler = circusState.addEventHandler
		assert(
			typeof(addEventHandler) == "function",
			"jest-circus circus/state exposes no addEventHandler"
		)

		module.install(
			addEventHandler,
			run.options.getMatcherState,
			run.options.getCoverage,
			run.installation.records
		)
	end)

	if not ok and run.installation.failure == nil then
		run.installation.failure = tostring(err)
	end
end

-- `setGlobalsForRuntime` is the one call circus's per-file `initialize` makes
-- back into the runtime, and it fires after that file's registry already holds
-- the circus state module — so it is the earliest point where there is a
-- dispatch list to join, once per test file.
--
-- Patched on the shared class table, the way setup-timing patches
-- `requireModule`, and left patched: the wrapper is inert while no run is
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
	Arm per-test attribution for the run that is about to start, returning the
	accumulator its test files will fill.

	Nothing is installed here — there is no registry to install into yet. This
	only names the run whose sink the per-file hook fills from now on.
]=]
function module.arm(options: ArmOptions): Installation
	patchRuntimeClass(options.runtimeClass)

	local installation: Installation = { failure = nil, records = {} }
	armedRun = {
		installation = installation,
		installed = setmetatable({}, { __mode = "k" }) :: any,
		options = options,
	}

	return installation
end

--[=[
	Stop attributing, so a run that wants no attribution gets none.

	The patch outlives the run that installed it, so silence has to be asked
	for: without this the next run's test files would keep filling the last
	run's accumulator, which nobody reads.
]=]
function module.disarm()
	armedRun = nil
end

return module
