--!strict
-- The test the run had reached, kept in memory for the abort that reads it.
-- Written synchronously on jest-circus's per-file event list, the one thing
-- still dispatching while a wedged run falls apart, and never published — so
-- the abort states the test rather than approximating it. `getMatcherState` and
-- `now` are injected, so nothing here needs circus, a clock, or a DataModel.

local CircusHook = require("./circus-hook")
local dataModelPath = require("./data-model-path")

type MatcherState = { currentTestName: string?, testPath: Instance? }

--[=[
	What the run was doing when the record was written.

	`finished` is every gap between tests: a hook, a teardown, and the next
	test file's imports, which is where a module that parks wedges the run.
]=]
export type State = "finished" | "running"

-- The record as it is stored: the state, who it is about, and when it began.
-- The elapsed time is derived on read rather than stored, because what the
-- abort wants to know is how long the state has held by the time the run was
-- given up on.
type Sighting = {
	sinceSeconds: number,
	state: State,
	testFilePath: string,
	testName: string,
}

--[=[
	The record as `describe` takes it, with the state's age filled in.

	`testName` is empty for a test circus had not named yet.
]=]
type Record = {
	elapsedMs: number,
	state: State,
	testFilePath: string,
	testName: string,
}

--[=[
	One run's last-seen record, overwritten as its test files run.

	`failure` is the first install that did not take, or the reason the hook
	never armed at all. It is reported as a field rather than thrown because
	the install happens inside jest's own per-file setup, where a throw fails
	that one test file instead of the run; the abort reads it back and says why
	it has no test to name.
]=]
export type Watch = {
	failure: string?,
	now: () -> number,
	sighting: Sighting?,
}

type InstallOptions = {
	getMatcherState: () -> MatcherState,
	watch: Watch,
}

export type ArmOptions = {
	--[=[
		jest-circus's `circus/state` ModuleScript, NOT the package root — see
		`CircusHook.ArmOptions`.
	]=]
	circusState: ModuleScript,
	getMatcherState: () -> MatcherState,
	now: () -> number,
	runtimeClass: any,
}

-- What one test file's handler carries. The path cache is per install and so
-- per test file, which is where it belongs: every test in a file shares one
-- `testPath`, and the ancestor walk is the expensive half of an event that
-- mostly only re-labels the same file.
type Handler = {
	cachedFilePath: string,
	cachedPath: Instance?,
	getMatcherState: () -> MatcherState,
	watch: Watch,
}

-- The circus events that move the record, and what each one moves it to.
-- Events not named here stop at the first line of the handler.
--
-- The test function's own end is a boundary apart from `test_done` because the
-- hooks that run between them are one of the places a run wedges.
--
-- No file boundary among them, though circus has one: `setup` is dispatched
-- before jest sets Expect's `testPath` for that file, so a record written
-- there would name the file before it. The gap between two files is reported
-- as what it is instead — no test running, and the last one that finished.
local STATE_BY_EVENT: { [string]: State } = {
	test_done = "finished",
	test_fn_failure = "finished",
	test_fn_start = "running",
	test_fn_success = "finished",
	test_start = "running",
}

local module = {}

-- The run currently recording, or nil when none is. Module scope because the
-- standing per-file hook outlives the run that armed it: both runners arm
-- immediately before `Jest.runCLI`, so the armed run is always the one whose
-- record the hook should write.
local armedWatch: Watch? = nil

local function onBoundary(handler: Handler, state: State)
	local matcher = handler.getMatcherState()
	local testPath = matcher.testPath
	if testPath ~= handler.cachedPath then
		handler.cachedPath = testPath
		handler.cachedFilePath = if testPath then dataModelPath(testPath) else ""
	end

	local testFilePath = handler.cachedFilePath
	local testName = matcher.currentTestName or ""
	local watch = handler.watch
	local sighting = watch.sighting
	if
		sighting ~= nil
		and sighting.state == state
		and sighting.testName == testName
		and sighting.testFilePath == testFilePath
	then
		-- Circus fires more than one event per state, and the clock times the
		-- state rather than the event that last confirmed it.
		return
	end

	watch.sighting = {
		sinceSeconds = watch.now(),
		state = state,
		testFilePath = testFilePath,
		testName = testName,
	}
end

-- A run's record before any test file has written to it.
local function newWatch(now: () -> number): Watch
	return { failure = nil, now = now, sighting = nil }
end

-- Register the record's handler on one test file's circus dispatch list.
local function install(addEventHandler: (handler: any) -> (), options: InstallOptions)
	local handler: Handler = {
		cachedFilePath = "",
		cachedPath = nil,
		getMatcherState = options.getMatcherState,
		watch = options.watch,
	}

	addEventHandler(function(_self: any, event: { name: string })
		local state = STATE_BY_EVENT[event.name]
		if state == nil then
			return
		end

		-- Circus does not guard event handlers (a throw rejects the run's
		-- dispatch chain), so the work is pcall-wrapped: the record is
		-- best-effort and must never be able to fail the run it observes.
		pcall(onBoundary, handler, state)
	end)
end

-- Stop recording, so a run never reads the previous run's record. The patch
-- outlives the run that armed it, so silence has to be asked for.
local function disarm()
	if armedWatch ~= nil then
		CircusHook.disarm(armedWatch)
		armedWatch = nil
	end
end

--[=[
	A record for a run whose hook could never go on, carrying why.

	The abort reads the reason back, so a run that named no test because the
	jest internals would not resolve says that rather than reading like a run
	that reached no test.

	@param failure -- Why the hook never armed.
]=]
function module.unarmed(failure: string): Watch
	disarm()

	-- The clock is never read: a watch with no sighting has nothing to time.
	local watch = newWatch(os.clock)
	watch.failure = failure
	return watch
end

--[=[
	Record the run that is about to start.

	Nothing is installed here — there is no registry to install into yet. This
	only names the run whose record the per-file hook writes from now on.

	@param options -- The run's clock and identity lookup, and the circus and
		runtime modules the per-file hook needs.
	@return The record to read on abandonment.
]=]
function module.arm(options: ArmOptions): Watch
	-- One armed run per VM: the standing per-file hook serves every consumer
	-- still armed, so a previous run left armed would keep writing a record
	-- nobody reads.
	disarm()

	local watch = newWatch(options.now)

	CircusHook.arm({
		circusState = options.circusState,
		install = function(addEventHandler)
			install(addEventHandler, {
				getMatcherState = options.getMatcherState,
				watch = watch,
			})
		end,
		report = watch,
		runtimeClass = options.runtimeClass,
	})

	armedWatch = watch
	return watch
end

-- What the run had reached, with the state's age filled in, or nil when nothing
-- was ever recorded.
local function record(watch: Watch): Record?
	local sighting = watch.sighting
	if sighting == nil then
		return nil
	end

	return {
		elapsedMs = math.floor((watch.now() - sighting.sinceSeconds) * 1000),
		state = sighting.state,
		testFilePath = sighting.testFilePath,
		testName = sighting.testName,
	}
end

local function quoted(testName: string): string
	return if testName == "" then "an unnamed test" else '"' .. testName .. '"'
end

--[=[
	The one line an abandoned run appends to what it reports.

	Stated rather than hedged: every boundary is written synchronously and
	nothing is throttled, so the record is what the run had reached and the
	wording can say so.

	@param watch -- The record `arm` returned, or nil for a run abandoned
		before it armed one.
]=]
function module.describe(watch: Watch?): string
	if watch == nil then
		return "No test was seen: the run was abandoned before Jest started"
	end

	local seen = record(watch)
	if seen == nil then
		local failure = watch.failure
		if failure ~= nil then
			return "No test was seen: the last-seen hook failed to install (" .. failure .. ")"
		end

		return "No test was seen: no test file reached the last-seen hook"
	end

	local elapsed = string.format("%.1fs", seen.elapsedMs / 1000)
	if seen.state == "running" then
		return string.format(
			"Last test seen: %s in %s (running for %s)",
			quoted(seen.testName),
			seen.testFilePath,
			elapsed
		)
	end

	return string.format(
		"No test was running; the last to finish was %s in %s (%s ago)",
		quoted(seen.testName),
		seen.testFilePath,
		elapsed
	)
end

return module
