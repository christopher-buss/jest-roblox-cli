--!strict
local CircusHook = require("./circus-hook")
local dataModelPath = require("./data-model-path")

type MatcherState = { currentTestName: string?, testPath: Instance? }

export type State = "finished" | "running"

type Sighting = {
	sinceSeconds: number,
	state: State,
	testFilePath: string,
	testName: string,
}

type Record = {
	elapsedMs: number,
	state: State,
	testFilePath: string,
	testName: string,
}

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
	-- `circus/state`, not the package root; see `CircusHook.ArmOptions`.
	circusState: ModuleScript,
	getMatcherState: () -> MatcherState,
	now: () -> number,
	runtimeClass: any,
}

type Handler = {
	cachedFilePath: string,
	cachedPath: Instance?,
	getMatcherState: () -> MatcherState,
	watch: Watch,
}

-- No `setup`: circus dispatches it before jest sets that file's `testPath`.
local STATE_BY_EVENT: { [string]: State } = {
	test_done = "finished",
	test_fn_failure = "finished",
	test_fn_start = "running",
	test_fn_success = "finished",
	test_start = "running",
}

local module = {}

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
		-- Keep the first event's time: the clock times the state, not the event.
		return
	end

	watch.sighting = {
		sinceSeconds = watch.now(),
		state = state,
		testFilePath = testFilePath,
		testName = testName,
	}
end

local function newWatch(now: () -> number): Watch
	return { failure = nil, now = now, sighting = nil }
end

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

		-- pcall: circus does not guard handlers; a throw rejects the run.
		pcall(onBoundary, handler, state)
	end)
end

local function disarm()
	if armedWatch ~= nil then
		CircusHook.disarm(armedWatch)
		armedWatch = nil
	end
end

function module.unarmed(failure: string): Watch
	disarm()

	local watch = newWatch(os.clock)
	watch.failure = failure
	return watch
end

function module.arm(options: ArmOptions): Watch
	-- Disarm first: the standing per-file hook serves every armed consumer.
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
