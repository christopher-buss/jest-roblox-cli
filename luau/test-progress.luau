--!strict
-- Per-test heartbeat, published out of the Luau VM as the run goes.
--
-- A test that never yields is not preempted by Roblox and starves every other
-- coroutine, so a task it wedges returns nothing at all: no output, no error,
-- no state. Jest's own `testTimeout` shares that dead scheduler and cannot
-- fire either. The only thing that survives is what already left the VM, which
-- is what this writes: one record per Open Cloud task, overwritten as the run
-- moves, naming the test the run had reached.
--
-- Writes are throttled because MemoryStore bills per request and a fast suite
-- runs far more tests per second than the quota allows. What the throttle
-- gives up is the exact test when a wedge lands within the window of the last
-- write; what it never gives up is the file, because a file change always
-- writes. See `shouldPublish`.
--
-- `getMatcherState`, `now` and `publish` are injected so the orchestration is
-- testable under lute without a real circus, a MemoryStore, or a Roblox
-- DataModel.

local CircusHook = require("./circus-hook")
local dataModelPath = require("./data-model-path")

--[=[
	Seconds between writes for one file. A wedge is slow by definition, so a
	window this size still names the wedged test whenever the test before it
	took at least this long; below that the record names the file and the last
	test seen inside it.
]=]
local MIN_PUBLISH_SECONDS = 1

local DEFAULT_TTL_SECONDS = 600

type MatcherState = { currentTestName: string?, testPath: Instance? }

--[=[
	One heartbeat record, as the host's `TestProgressEntry` reads it.

	`testName` is empty for a record written before the file's first test named
	itself, which still locates the run to a file.
]=]
-- The two states a record can be written in. Kept a union rather than a plain
-- string because the host validates it as one: a third value invented here
-- would not decode, and the wedge report would fall back to the bare timeout.
export type State = "completed" | "started"

export type Entry = {
	elapsedMs: number,
	state: State,
	testFilePath: string,
	testName: string,
}

export type Publish = (Entry) -> ()

--[=[
	What one run has published so far.

	Run-wide rather than per test file: the throttle and the elapsed clock both
	measure the run, and each test file installs a handler of its own.
]=]
export type Heartbeat = {
	lastFile: string,
	-- The Instance `lastFile` was named from, so a test in the file already
	-- published is recognised without walking its ancestors again. Every test
	-- in a file shares one `testPath`, and the walk is the expensive half of
	-- an event this handler mostly declines to act on.
	lastPath: Instance?,
	lastPublishAt: number,
	startedAt: number,
}

export type InstallOptions = {
	getMatcherState: () -> MatcherState,
	heartbeat: Heartbeat,
	now: () -> number,
	publish: Publish,
}

export type ArmOptions = {
	circusState: ModuleScript,
	getMatcherState: () -> MatcherState,
	now: (() -> number)?,
	publish: Publish,
	runtimeClass: any,
}

--[=[
	An armed run's report, which is `CircusHook.Report` plus nothing: a
	heartbeat has no output to collect, only an install that may not have
	taken.
]=]
export type Armed = CircusHook.Report

local module = {}

-- The run currently heartbeating, or nil when none is. One per VM: the
-- standing per-file hook serves every consumer still armed, so a previous run
-- left armed would keep writing into a map the host has stopped reading.
local armedRun: Armed? = nil

-- The state a circus event names, or nil for an event that is not a test
-- boundary.
local function stateForEvent(eventName: string): State?
	if eventName == "test_start" then
		return "started"
	elseif eventName == "test_done" then
		return "completed"
	end

	return nil
end

--[=[
	Whether this record is worth a MemoryStore request.

	A file the run has not published yet always is: the file is the coarse
	answer that stays exact however fast the tests inside it are, so a wedge
	always leaves its own file as the last one published. Inside a file the
	window applies, which is what keeps a suite running hundreds of tests a
	second inside the request quota.
]=]
local function shouldPublish(heartbeat: Heartbeat, testFilePath: string, at: number): boolean
	return testFilePath ~= heartbeat.lastFile or at - heartbeat.lastPublishAt >= MIN_PUBLISH_SECONDS
end

--[=[
	A fresh run's heartbeat state.

	@param now -- The run's clock, in seconds.
	@return The state to hand every test file's install.
]=]
function module.newHeartbeat(now: () -> number): Heartbeat
	local startedAt = now()
	return {
		-- No file has been published, and no real file path is empty, so the
		-- first record of the run always writes.
		lastFile = "",
		lastPath = nil,
		lastPublishAt = startedAt - MIN_PUBLISH_SECONDS,
		startedAt = startedAt,
	}
end

--[=[
	Register the heartbeat on one circus dispatch list.

	@param addEventHandler -- That file's `circus/state.addEventHandler`.
	@param options -- The run's clock, sink, identity lookup, and shared state.
]=]
-- The whole of what one test boundary does, at module scope so the handler
-- below hands it to `pcall` instead of allocating a closure per event.
local function onBoundary(options: InstallOptions, state: State)
	local heartbeat = options.heartbeat
	local matcher = options.getMatcherState()
	local testPath = matcher.testPath
	-- Identity first: every test in a file shares one `testPath`, so this is
	-- what keeps the ancestor walk to once per file rather than once per event.
	local testFilePath = heartbeat.lastFile
	if testPath ~= heartbeat.lastPath then
		testFilePath = if testPath then dataModelPath(testPath) else ""
	end

	local at = options.now()
	if not shouldPublish(heartbeat, testFilePath, at) then
		return
	end

	heartbeat.lastFile = testFilePath
	heartbeat.lastPath = testPath
	heartbeat.lastPublishAt = at
	options.publish({
		elapsedMs = math.floor((at - heartbeat.startedAt) * 1000),
		state = state,
		testFilePath = testFilePath,
		testName = matcher.currentTestName or "",
	})
end

function module.install(addEventHandler: (handler: any) -> (), options: InstallOptions)
	-- Circus fires many events per test — describe boundaries, every hook,
	-- the test function itself — and all but two of them stop at the first
	-- line here, before anything is allocated.
	addEventHandler(function(_self: any, event: { name: string })
		local state = stateForEvent(event.name)
		if state == nil then
			return
		end

		-- Circus does not guard event handlers (a throw rejects the run's
		-- dispatch chain), so the work is pcall-wrapped: a heartbeat is
		-- best-effort and must never be able to fail the run it observes.
		pcall(onBoundary, options, state)
	end)
end

--[=[
	Heartbeat the run that is about to start.

	@param options -- Where to publish, how to read the current test, and the
		circus/runtime modules the per-file hook needs.
	@return The report to read an install failure off, and to disarm with.
]=]
function module.arm(options: ArmOptions): Armed
	module.disarm(armedRun)

	local now = options.now or os.clock
	local heartbeat = module.newHeartbeat(now)
	local report: Armed = { failure = nil }

	CircusHook.arm({
		circusState = options.circusState,
		install = function(addEventHandler)
			module.install(addEventHandler, {
				getMatcherState = options.getMatcherState,
				heartbeat = heartbeat,
				now = now,
				publish = options.publish,
			})
		end,
		report = report,
		runtimeClass = options.runtimeClass,
	})

	armedRun = report
	return report
end

--[=[
	Stop heartbeating, so a run that publishes nothing keeps publishing
	nothing.

	@param armed -- The report `arm` returned.
]=]
function module.disarm(armed: Armed?)
	if armed == nil then
		return
	end

	CircusHook.disarm(armed)
	if armedRun == armed then
		armedRun = nil
	end
end

--[=[
	Stop whichever run is heartbeating, if any.

	The VM holds one heartbeat at a time, so a caller that only wants silence
	does not have to have kept the handle to ask for it.
]=]
function module.disarmCurrent()
	module.disarm(armedRun)
end

--[=[
	A sink that writes each record into the run's SortedMap.

	One key per task, generated here and overwritten for the life of the task:
	the host asks which test a wedged task reached, and a key per test would
	answer that by making it sort a whole run's worth of history. Concurrent
	tasks each generate their own, so a sharded run comes back one record per
	task.

	Best-effort — a MemoryStore that refuses the write (no scope, quota spent)
	must not fail the run it is only describing.

	@param mapId -- The run's SortedMap.
	@param ttlSeconds -- TTL for each write, or the module default.
	@return The sink to hand `arm`.
]=]
function module.sortedMapPublisher(mapId: string, ttlSeconds: number?): Publish
	local HttpService = game:GetService("HttpService")
	local MemoryStoreService = game:GetService("MemoryStoreService")
	local key = HttpService:GenerateGUID(false)
	local sortedMap = MemoryStoreService:GetSortedMap(mapId)
	local ttl = ttlSeconds or DEFAULT_TTL_SECONDS

	return function(entry: Entry)
		pcall(sortedMap.SetAsync, sortedMap, key, entry, ttl)
	end
end

return module
