--!nocheck
-- Lute-driven test for the per-test coverage hook: its orchestration (snapshot
-- on test_start, diff on test_done, read the matcher state for the test's
-- identity) and where it installs itself (inside each test file's own module
-- registry, never once per run). The module under test is inlined into the
-- placeholder below (with its coverage-attribution dependency already inlined
-- by the spec). Circus and the jest runtime are stood in for, so no Roblox and
-- no engine — but the stand-ins keep the two properties the hook turns on:
-- circus's handler list is module scope, and jest gives every test file a fresh
-- module registry. Any failed assertion calls error(), failing the wrapper spec.

local PerTestCoverage = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

local function contains(list: { number }, value: number): boolean
	for _, element in list do
		if element == value then
			return true
		end
	end

	return false
end

local function makeInstance(name: string, parent: any): any
	return { Name = name, Parent = parent }
end

-- A service-rooted file: the topmost fake (Parent = nil) stands in for `game`
-- and is excluded from the path.
local function makeFakeFile(): any
	local root = makeInstance("game", nil)
	local replicatedStorage = makeInstance("ReplicatedStorage", root)
	local folder = makeInstance("Foo", replicatedStorage)

	return makeInstance("bar.spec", folder)
end

local function makeDispatcher()
	local handler: any
	local function addEventHandler(registered: any)
		handler = registered
	end

	local function dispatch(event: any)
		handler(nil, event)
	end

	return addEventHandler, dispatch
end

-- T1: a test that covers a statement records its file, name, and delta.
local function testRecordsCoverage()
	local addEventHandler, dispatch = makeDispatcher()
	local state = { currentTestName = "Foo > adds", testPath = makeFakeFile() }
	local cov = {}
	local records = PerTestCoverage.install(addEventHandler, function()
		return state
	end, function()
		return cov
	end)

	dispatch({ name = "test_start" })
	cov["out/m.luau"] = { s = { 1 } }
	dispatch({ name = "test_done" })

	check(#records == 1, "T1: one record produced")
	check(records[1].testFilePath == "ReplicatedStorage/Foo/bar.spec", "T1: service-rooted file path")
	check(records[1].testCaseId == "Foo > adds", "T1: full test name")
	check(contains(records[1].delta["out/m.luau"].s, 1), "T1: statement 1 attributed")
end

-- T2: a test that covers nothing new produces no record.
local function testDropsEmptyTest()
	local addEventHandler, dispatch = makeDispatcher()
	local state = { currentTestName = "Foo > noop", testPath = makeFakeFile() }
	local cov = { ["out/m.luau"] = { s = { 1 } } }
	local records = PerTestCoverage.install(addEventHandler, function()
		return state
	end, function()
		return cov
	end)

	dispatch({ name = "test_start" })
	-- nothing changes before test_done
	dispatch({ name = "test_done" })

	check(#records == 0, "T2: no record for a test that covered nothing")
end

-- T3: two sequential tests against a cumulative table each get their own delta.
local function testSequentialTests()
	local addEventHandler, dispatch = makeDispatcher()
	local state = { currentTestName = "first", testPath = makeFakeFile() }
	local cov = { ["out/m.luau"] = { s = { 0 } } }
	local records = PerTestCoverage.install(addEventHandler, function()
		return state
	end, function()
		return cov
	end)

	dispatch({ name = "test_start" })
	cov["out/m.luau"].s[1] = 1
	dispatch({ name = "test_done" })

	state.currentTestName = "second"
	dispatch({ name = "test_start" })
	cov["out/m.luau"].s[1] = 2
	dispatch({ name = "test_done" })

	check(#records == 2, "T3: a record per test")
	check(records[1].testCaseId == "first", "T3: first test recorded")
	check(records[2].testCaseId == "second", "T3: second test recorded")
end

-- T4: an error while reading the test identity must be swallowed — circus does
-- not guard event handlers, so a throw would break the whole coverage run.
local function testHandlerSwallowsErrors()
	local addEventHandler, dispatch = makeDispatcher()
	local cov = {}
	local records = PerTestCoverage.install(addEventHandler, function()
		error("matcher state unavailable")
	end, function()
		return cov
	end)

	dispatch({ name = "test_start" })
	cov["out/m.luau"] = { s = { 1 } }
	local ok = pcall(dispatch, { name = "test_done" })

	check(ok, "T4: a throwing identity lookup must not propagate out of the handler")
	check(#records == 0, "T4: nothing recorded when the identity is unavailable")
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
		dispatch = function(event: any)
			for _, handler in eventHandlers do
				handler(nil, event, {})
			end
		end,
		handlerCount = function()
			return #eventHandlers
		end,
	}
end

-- Stands in for the `circus/state` ModuleScript the runner resolves.
local CIRCUS_STATE_MODULE = { Name = "state" }

-- The one bad shape this hook exists to rule out: the JestCircus package root,
-- which re-exports `circus/init` and so carries no `addEventHandler`.
local CIRCUS_ROOT_MODULE = { Name = "JestCircus" }

-- jest-runtime, one instance per test file, each with its own internal module
-- registry — which is what makes a handler installed once before the run reach
-- no test file at all.
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

-- One test file the way jest runs it: a fresh runtime, circus's per-file
-- `initialize` loading the state module into that runtime's registry and then
-- calling back through `setGlobalsForRuntime`, then the file's cases.
local function runTestFile(matcherState: any, coverage: any, filePath: any, cases: { any })
	local runtime = RuntimeClass.new()
	local circus = runtime:requireInternalModule(CIRCUS_STATE_MODULE)
	matcherState.testPath = filePath

	runtime:setGlobalsForRuntime({})

	for _, case in cases do
		matcherState.currentTestName = case.name
		circus.dispatch({ name = "test_start" })
		coverage[case.file] = { s = { 1 } }
		circus.dispatch({ name = "test_done" })
	end

	return circus
end

local function makeSpecFile(name: string): any
	local root = makeInstance("game", nil)
	local replicatedStorage = makeInstance("ReplicatedStorage", root)

	return makeInstance(name, replicatedStorage)
end

local function armAgainst(coverage: any, matcherState: any, stateModule: any)
	return PerTestCoverage.arm({
		circusState = stateModule,
		getCoverage = function()
			return coverage
		end,
		getMatcherState = function()
			return matcherState
		end,
		runtimeClass = RuntimeClass,
	})
end

-- T5: a run spanning two test files records every case in both. Regression for
-- the per-run install: the hook has to join the list each file dispatches
-- through, and arming before the run joins none of them.
local function testInstallsInEveryTestFile()
	local coverage = {}
	local matcherState = {}
	local installation = armAgainst(coverage, matcherState, CIRCUS_STATE_MODULE)

	local first = runTestFile(matcherState, coverage, makeSpecFile("a.spec"), {
		{ file = "out/a1.luau", name = "a adds" },
		{ file = "out/a2.luau", name = "a subtracts" },
	})
	local second = runTestFile(matcherState, coverage, makeSpecFile("b.spec"), {
		{ file = "out/b1.luau", name = "b adds" },
		{ file = "out/b2.luau", name = "b subtracts" },
	})

	local records = installation.records
	check(installation.failure == nil, "T5: the install took")
	check(#records == 4, "T5: a record per case across both files, got " .. #records)
	check(records[1].testCaseId == "a adds", "T5: the first file's first case")
	check(records[4].testCaseId == "b subtracts", "T5: the second file's last case")
	check(
		records[1].testFilePath == "ReplicatedStorage/a.spec",
		"T5: records carry their own file"
	)
	check(records[3].testFilePath == "ReplicatedStorage/b.spec", "T5: and the second file's")
	check(contains(records[3].delta["out/b1.luau"].s, 1), "T5: the case's own delta")
	check(first.handlerCount() == 1, "T5: one handler on the first file's list")
	check(second.handlerCount() == 1, "T5: one handler on the second file's list")
end

-- T6: disarming stops the standing patch attributing, so a run that wants no
-- attribution does not keep filling the previous run's accumulator.
local function testDisarmStopsAttributing()
	local coverage = {}
	local matcherState = {}
	local installation = armAgainst(coverage, matcherState, CIRCUS_STATE_MODULE)

	PerTestCoverage.disarm()

	local circus = runTestFile(matcherState, coverage, makeSpecFile("c.spec"), {
		{ file = "out/c1.luau", name = "c adds" },
	})

	check(#installation.records == 0, "T6: a disarmed run records nothing")
	check(circus.handlerCount() == 0, "T6: and installs no handler")
end

-- T7: arming against the JestCircus package root — the module that has no
-- `addEventHandler` — reports the failure instead of throwing out of jest's
-- per-file setup, where it would read as a broken test file.
local function testMissingAddEventHandlerIsReported()
	local coverage = {}
	local matcherState = {}
	local installation = armAgainst(coverage, matcherState, CIRCUS_ROOT_MODULE)

	local ok = pcall(runTestFile, matcherState, coverage, makeSpecFile("d.spec"), {
		{ file = "out/d1.luau", name = "d adds" },
	})

	check(ok, "T7: the failed install does not break the test file")
	check(installation.failure ~= nil, "T7: the failure is reported on the installation")
	check(#installation.records == 0, "T7: and nothing is attributed")
	PerTestCoverage.disarm()
end

testRecordsCoverage()
testDropsEmptyTest()
testSequentialTests()
testHandlerSwallowsErrors()
testInstallsInEveryTestFile()
testDisarmStopsAttributing()
testMissingAddEventHandlerIsReported()

print("ALL OK")
