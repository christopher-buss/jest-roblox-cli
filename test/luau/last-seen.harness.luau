--!nocheck
-- Lute-driven test for the last-seen record: what it writes on each circus
-- boundary, how long it says that state has held, and what it says when there
-- is nothing to say. The module under test is inlined into the placeholder
-- below (with its circus-hook and data-model-path dependencies already inlined
-- by the spec). Every case drives it the way a run does — `arm`, then test
-- files against a stood-in circus and jest runtime — so no Roblox and no
-- engine, and the stand-ins keep the property the record turns on: jest gives
-- every test file a fresh module registry, so the handler goes in per file. Any
-- failed assertion calls error(), failing the wrapper spec.

local LastSeen = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

local function checkContains(haystack: string, needle: string, message: string)
	if string.find(haystack, needle, 1, true) == nil then
		fail(message .. ", got: " .. haystack)
	end
end

local function makeInstance(name: string, parent: any): any
	return { Name = name, Parent = parent }
end

-- A service-rooted file: the topmost fake (Parent = nil) stands in for `game`
-- and is excluded from the path.
local function makeSpecFile(name: string): any
	local root = makeInstance("game", nil)
	local replicatedStorage = makeInstance("ReplicatedStorage", root)

	return makeInstance(name, replicatedStorage)
end

-- A clock the tests advance by hand, so elapsed time is stated rather than
-- measured.
local function makeClock()
	local seconds = 0

	return function()
		return seconds
	end, function(delta: number)
		seconds += delta
	end
end

-- === A jest that rebuilds its module registry per test file ===

-- `circus/state`'s dispatch registry, as `circus/combined.lua` builds it:
-- `eventHandlers` is a module-scope list there, so a registry that loads the
-- module afresh gets a list of its own and dispatches only through that one.
local function makeCircusState()
	local eventHandlers: { any } = {}

	return {
		addEventHandler = function(handler: any)
			table.insert(eventHandlers, handler)
		end,
		dispatch = function(name: string)
			for _, handler in eventHandlers do
				handler(nil, { name = name }, {})
			end
		end,
		handlerCount = function()
			return #eventHandlers
		end,
	}
end

local CIRCUS_STATE_MODULE = { Name = "state" }

-- The one bad shape this hook exists to rule out: the JestCircus package root,
-- which re-exports `circus/init` and so carries no `addEventHandler`.
local CIRCUS_ROOT_MODULE = { Name = "JestCircus" }

local RuntimeClass = {}
RuntimeClass.__index = RuntimeClass

function RuntimeClass.new()
	return setmetatable({ internalRegistry = {} }, RuntimeClass)
end

function RuntimeClass:requireInternalModule(moduleScript: any)
	local cached = self.internalRegistry[moduleScript]
	if cached == nil then
		cached = if moduleScript == CIRCUS_ROOT_MODULE
			then { run = function() end }
			else makeCircusState()
		self.internalRegistry[moduleScript] = cached
	end

	return cached
end

function RuntimeClass:setGlobalsForRuntime(globals: any)
	self.jestGlobals = globals
end

local function armAgainst(matcherState: any, stateModule: any, now: () -> number)
	return LastSeen.arm({
		circusState = stateModule,
		getMatcherState = function()
			return matcherState
		end,
		now = now,
		runtimeClass = RuntimeClass,
	})
end

-- What jest does when it opens one test file: a fresh runtime, circus's
-- per-file `initialize` loading the state module into that runtime's registry
-- and then calling back through `setGlobalsForRuntime`. Returns that file's own
-- dispatch list, which is the only list a handler can usefully join.
local function openTestFile(matcherState: any, filePath: any)
	local runtime = RuntimeClass.new()
	local circus = runtime:requireInternalModule(CIRCUS_STATE_MODULE)
	matcherState.testPath = filePath

	runtime:setGlobalsForRuntime({})
	return circus
end

local function runTestFile(matcherState: any, filePath: any, caseNames: { string })
	local circus = openTestFile(matcherState, filePath)
	for _, caseName in caseNames do
		matcherState.currentTestName = caseName
		circus.dispatch("test_start")
		circus.dispatch("test_done")
	end

	return circus
end

-- T1: a test that is running is recorded by name, by file, and as running.
local function testRecordsTheRunningTest()
	local now, advance = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local circus = openTestFile(matcherState, makeSpecFile("wedge.spec"))
	matcherState.currentTestName = "wedge never yields"
	circus.dispatch("test_start")
	advance(52.34)

	checkContains(
		LastSeen.describe(watch),
		'Last test seen: "wedge never yields" in ReplicatedStorage/wedge.spec (running for 52.3s)',
		"T1: the abort names the running test, its file, and how long it has run"
	)
end

-- T2: a test that has finished is recorded as finished, and the elapsed clock
-- restarts at the boundary — what wedged is whatever ran after it.
local function testRecordsTheFinishedTest()
	local now, advance = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local circus = openTestFile(matcherState, makeSpecFile("wedge.spec"))
	matcherState.currentTestName = "wedge adds"
	circus.dispatch("test_start")
	advance(4)
	circus.dispatch("test_done")
	advance(11)

	checkContains(
		LastSeen.describe(watch),
		'No test was running; the last to finish was "wedge adds" in ReplicatedStorage/wedge.spec (11.0s ago)',
		"T2: the abort names the last test to finish, timed from the boundary"
	)
end

-- T3: the test function ending is a boundary of its own, so a wedge in an
-- afterEach is not reported as the test still running.
local function testTestFunctionEndFinishesTheTest()
	local now, advance = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local circus = openTestFile(matcherState, makeSpecFile("wedge.spec"))
	matcherState.currentTestName = "wedge adds"
	circus.dispatch("test_start")
	circus.dispatch("test_fn_start")
	advance(2)
	circus.dispatch("test_fn_success")
	advance(3)

	checkContains(
		LastSeen.describe(watch),
		'No test was running; the last to finish was "wedge adds" in ReplicatedStorage/wedge.spec (3.0s ago)',
		"T3: a returned test function ends the test, timed from the return"
	)

	circus.dispatch("test_fn_failure")
	checkContains(
		LastSeen.describe(watch),
		"No test was running",
		"T3: a thrown test function ends it too"
	)
end

-- T4: a repeated boundary for the same test does not restart the clock — the
-- record times the state, and circus fires more than one event per state.
local function testRepeatedBoundaryKeepsTheClock()
	local now, advance = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local circus = openTestFile(matcherState, makeSpecFile("wedge.spec"))
	matcherState.currentTestName = "wedge adds"
	circus.dispatch("test_fn_success")
	advance(6)
	circus.dispatch("test_done")

	checkContains(
		LastSeen.describe(watch),
		"(6.0s ago)",
		"T4: the second boundary keeps the first's clock"
	)
end

-- T5: a run wedged between files — the next file's imports parked — reports
-- the last test that finished, in the file it finished in.
local function testWedgeBetweenFilesNamesTheLastTest()
	local now, advance = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	runTestFile(matcherState, makeSpecFile("old.spec"), { "old adds" })
	advance(9)

	checkContains(
		LastSeen.describe(watch),
		'No test was running; the last to finish was "old adds" in ReplicatedStorage/old.spec (9.0s ago)',
		"T5: the abort names the last test to finish"
	)
end

-- T6: circus's own file boundary is ignored on purpose. Jest sets Expect's
-- `testPath` for a file after dispatching `setup`, so a record written there
-- would name the file before it — which reads as the run having reached a file
-- it had already left.
local function testFileBoundaryIsIgnored()
	local now = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	runTestFile(matcherState, makeSpecFile("old.spec"), { "old adds" })
	local next = openTestFile(matcherState, makeSpecFile("new.spec"))
	next.dispatch("setup")

	checkContains(
		LastSeen.describe(watch),
		'the last to finish was "old adds" in ReplicatedStorage/old.spec',
		"T6: a file boundary moves nothing"
	)
end

-- T7: circus does not guard event handlers, so a throwing identity lookup must
-- stop at the handler rather than reject the run's dispatch chain.
local function testHandlerSwallowsErrors()
	local now = makeClock()
	local watch = LastSeen.arm({
		circusState = CIRCUS_STATE_MODULE,
		getMatcherState = function()
			error("matcher state unavailable")
		end,
		now = now,
		runtimeClass = RuntimeClass,
	})

	local circus = openTestFile({}, makeSpecFile("wedge.spec"))
	local ok = pcall(circus.dispatch, "test_start")

	check(ok, "T7: a throwing identity lookup does not propagate out of the handler")
	checkContains(
		LastSeen.describe(watch),
		"no test file reached the last-seen hook",
		"T7: and nothing is recorded"
	)
end

-- T8: a run nothing ever wrote to says so, rather than leaving the abort to
-- imply the run reached no test at all.
local function testEmptyWatchSaysSo()
	local now = makeClock()
	local watch = armAgainst({}, CIRCUS_STATE_MODULE, now)

	checkContains(
		LastSeen.describe(watch),
		"no test file reached the last-seen hook",
		"T8: an armed run no test file reached says so"
	)
	checkContains(
		LastSeen.describe(nil),
		"the run was abandoned before Jest started",
		"T8: no watch at all says the run never got that far"
	)
end

-- T9: a run spanning two test files records the last case of the last file.
-- Regression for the per-run install: the hook has to join the list each file
-- dispatches through, and arming before the run joins none of them.
local function testInstallsInEveryTestFile()
	local now = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local first = runTestFile(matcherState, makeSpecFile("a.spec"), { "a adds" })
	local second = runTestFile(matcherState, makeSpecFile("b.spec"), { "b adds", "b subtracts" })

	check(watch.failure == nil, "T9: the install took")
	check(first.handlerCount() == 1, "T9: one handler on the first file's list")
	check(second.handlerCount() == 1, "T9: one handler on the second file's list")
	checkContains(
		LastSeen.describe(watch),
		'the last to finish was "b subtracts" in ReplicatedStorage/b.spec',
		"T9: the last case of the last file, recorded against its own file"
	)
end

-- T10: arming a second run stands the first one down, so a run never reads the
-- previous run's record. The per-file patch outlives the run that armed it, so
-- silence has to be asked for.
local function testArmingAgainStandsThePreviousRunDown()
	local now = makeClock()
	local matcherState: any = {}
	local first = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)
	local second = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local circus = runTestFile(matcherState, makeSpecFile("c.spec"), { "c adds" })

	check(circus.handlerCount() == 1, "T10: only the run still armed installs a handler")
	checkContains(
		LastSeen.describe(first),
		"no test file reached the last-seen hook",
		"T10: the run that was stood down records nothing"
	)
	checkContains(
		LastSeen.describe(second),
		'the last to finish was "c adds"',
		"T10: and the run that armed after it does"
	)
end

-- T11: arming against the JestCircus package root — the module that has no
-- `addEventHandler` — reports the failure instead of throwing out of jest's
-- per-file setup, and the abort says why it has nothing to name.
local function testMissingAddEventHandlerIsReported()
	local now = makeClock()
	local matcherState: any = {}
	local watch = armAgainst(matcherState, CIRCUS_ROOT_MODULE, now)

	local ok = pcall(runTestFile, matcherState, makeSpecFile("d.spec"), { "d adds" })

	check(ok, "T11: the failed install does not break the test file")
	check(watch.failure ~= nil, "T11: the failure is reported on the watch")
	checkContains(
		LastSeen.describe(watch),
		"the last-seen hook failed to install",
		"T11: the abort says the hook never went on"
	)
end

-- T12: a run whose jest internals could not be resolved gets a watch that
-- carries the reason, and stands down whatever was armed before it — the abort
-- must name why it has no test rather than read the previous run's record.
local function testUnarmedWatchCarriesItsReason()
	local now = makeClock()
	local matcherState: any = {}
	local armed = armAgainst(matcherState, CIRCUS_STATE_MODULE, now)

	local watch = LastSeen.unarmed("could not resolve the jest-circus package")
	local circus = runTestFile(matcherState, makeSpecFile("e.spec"), { "e adds" })

	check(circus.handlerCount() == 0, "T12: an unarmed run installs no handler")
	checkContains(
		LastSeen.describe(armed),
		"no test file reached the last-seen hook",
		"T12: and the run it stood down records nothing"
	)
	checkContains(
		LastSeen.describe(watch),
		"could not resolve the jest-circus package",
		"T12: the abort carries the reason the hook never armed"
	)
end

testRecordsTheRunningTest()
testRecordsTheFinishedTest()
testTestFunctionEndFinishesTheTest()
testRepeatedBoundaryKeepsTheClock()
testWedgeBetweenFilesNamesTheLastTest()
testFileBoundaryIsIgnored()
testHandlerSwallowsErrors()
testEmptyWatchSaysSo()
testInstallsInEveryTestFile()
testArmingAgainStandsThePreviousRunDown()
testMissingAddEventHandlerIsReported()
testUnarmedWatchCarriesItsReason()

print("ALL OK")
