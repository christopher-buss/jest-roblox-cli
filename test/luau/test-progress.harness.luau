--!nocheck
-- Lute-driven test for the per-test progress heartbeat: what it publishes on
-- each circus event, which writes the throttle lets through, and that it joins
-- the dispatch list of every test file rather than installing once per run.
-- The module under test is inlined into the placeholder below (with its
-- circus-hook dependency already inlined by the spec). Circus and the jest
-- runtime are stood in for, so no Roblox and no engine. Any failed assertion
-- calls error(), failing the wrapper spec.

local TestProgress = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
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

-- A clock the test moves by hand, so the throttle window is exercised without
-- the harness waiting on a real one.
local function makeClock()
	local seconds = { value = 0 }

	return seconds, function()
		return seconds.value
	end
end

local function makeRig()
	local seconds, now = makeClock()
	local matcher = { currentTestName = nil, testPath = nil }
	local published: { any } = {}
	local addEventHandler, dispatch = makeDispatcher()

	TestProgress.install(addEventHandler, {
		getMatcherState = function()
			return matcher
		end,
		heartbeat = TestProgress.newHeartbeat(now),
		now = now,
		publish = function(entry: any)
			table.insert(published, entry)
		end,
	})

	return {
		dispatch = dispatch,
		matcher = matcher,
		published = published,
		seconds = seconds,
	}
end

-- T1: the first test of a file publishes it as started, named and located.
local function testPublishesFirstTest()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")
	rig.matcher.currentTestName = "Foo > wedges"

	rig.dispatch({ name = "test_start" })

	check(#rig.published == 1, "T1: one write, got " .. #rig.published)
	local entry = rig.published[1]
	check(entry.testFilePath == "ReplicatedStorage/a.spec", "T1: service-rooted file path")
	check(entry.testName == "Foo > wedges", "T1: full test name")
	check(entry.state == "started", "T1: state is started")
end

-- T2: the throttle is what keeps a fast suite inside the MemoryStore request
-- quota. A second test in the same file, inside the window, writes nothing.
local function testThrottlesWithinAFile()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")
	rig.matcher.currentTestName = "first"
	rig.dispatch({ name = "test_start" })

	rig.seconds.value = 0.2
	rig.matcher.currentTestName = "second"
	rig.dispatch({ name = "test_start" })

	check(#rig.published == 1, "T2: the second write is throttled, got " .. #rig.published)
end

-- T3: once the window has passed the next test writes again, so a run longer
-- than the window never goes unreported for longer than it.
local function testPublishesAfterTheWindow()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")
	rig.matcher.currentTestName = "first"
	rig.dispatch({ name = "test_start" })

	rig.seconds.value = 5
	rig.matcher.currentTestName = "second"
	rig.dispatch({ name = "test_start" })

	check(#rig.published == 2, "T3: the later test writes, got " .. #rig.published)
	check(rig.published[2].testName == "second", "T3: and names itself")
end

-- T4: a new file always writes, whatever the throttle says. The file is the
-- coarse answer that stays exact however fast the tests inside it are, so a
-- wedge always leaves its own file as the last one published.
local function testAlwaysPublishesANewFile()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")
	rig.matcher.currentTestName = "first"
	rig.dispatch({ name = "test_start" })

	rig.seconds.value = 0.1
	rig.matcher.testPath = makeSpecFile("b.spec")
	rig.matcher.currentTestName = "second"
	rig.dispatch({ name = "test_start" })

	check(#rig.published == 2, "T4: a new file writes inside the window")
	check(rig.published[2].testFilePath == "ReplicatedStorage/b.spec", "T4: naming the new file")
end

-- T5: a finished test is published as completed, which is what tells the host
-- the wedge is in a later test rather than this one.
local function testPublishesCompletion()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")
	rig.matcher.currentTestName = "first"
	rig.dispatch({ name = "test_start" })

	rig.seconds.value = 3
	rig.dispatch({ name = "test_done" })

	check(#rig.published == 2, "T5: the completion writes")
	check(rig.published[2].state == "completed", "T5: as completed")
	check(rig.published[2].elapsedMs == 3000, "T5: elapsed from the run start")
end

-- T6: an event that is not a test boundary writes nothing.
local function testIgnoresOtherEvents()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")

	rig.dispatch({ name = "setup" })

	check(#rig.published == 0, "T6: no write for an unrelated event")
end

-- T7: circus does not guard event handlers, so a throw would reject the run's
-- dispatch chain. A heartbeat must never be able to fail the run it observes.
local function testSwallowsErrors()
	local _seconds, now = makeClock()
	local addEventHandler, dispatch = makeDispatcher()
	local published: { any } = {}
	TestProgress.install(addEventHandler, {
		getMatcherState = function()
			error("matcher state unavailable")
		end,
		heartbeat = TestProgress.newHeartbeat(now),
		now = now,
		publish = function(entry: any)
			table.insert(published, entry)
		end,
	})

	local ok = pcall(dispatch, { name = "test_start" })

	check(ok, "T7: a throwing identity lookup must not propagate out of the handler")
	check(#published == 0, "T7: and nothing is published")
end

-- T8: a file whose first test has yet to start still locates the run.
local function testPublishesFileWithoutATest()
	local rig = makeRig()
	rig.matcher.testPath = makeSpecFile("a.spec")

	rig.dispatch({ name = "test_start" })

	check(rig.published[1].testName == "", "T8: no test name yet")
	check(rig.published[1].testFilePath == "ReplicatedStorage/a.spec", "T8: but the file is known")
end

-- === A jest that rebuilds its module registry per test file ===

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

local CIRCUS_STATE_MODULE = { Name = "state" }

local RuntimeClass = {}
RuntimeClass.__index = RuntimeClass

function RuntimeClass.new()
	return setmetatable({ internalRegistry = {} }, RuntimeClass)
end

function RuntimeClass:requireInternalModule(moduleScript: any)
	local cached = self.internalRegistry[moduleScript]
	if cached == nil then
		cached = makeCircusState()
		self.internalRegistry[moduleScript] = cached
	end

	return cached
end

function RuntimeClass:setGlobalsForRuntime(globals: any)
	self.jestGlobals = globals
end

local function runTestFile(matcher: any, filePath: any, names: { string })
	local runtime = RuntimeClass.new()
	local circus = runtime:requireInternalModule(CIRCUS_STATE_MODULE)
	matcher.testPath = filePath

	runtime:setGlobalsForRuntime({})

	for _, name in names do
		matcher.currentTestName = name
		circus.dispatch({ name = "test_start" })
		circus.dispatch({ name = "test_done" })
	end

	return circus
end

-- T9: a run spanning two test files publishes from both. Regression for the
-- per-run install: the hook has to join the list each file dispatches through,
-- and arming before the run joins none of them.
local function testInstallsInEveryTestFile()
	local matcher = { currentTestName = nil, testPath = nil }
	local published: { any } = {}
	local armed = TestProgress.arm({
		circusState = CIRCUS_STATE_MODULE,
		getMatcherState = function()
			return matcher
		end,
		publish = function(entry: any)
			table.insert(published, entry)
		end,
		runtimeClass = RuntimeClass,
	})

	local first = runTestFile(matcher, makeSpecFile("a.spec"), { "a one", "a two" })
	local second = runTestFile(matcher, makeSpecFile("b.spec"), { "b one", "b two" })
	TestProgress.disarm(armed)

	check(armed.failure == nil, "T9: the install took")
	check(#published > 0, "T9: the run published")
	check(published[1].testFilePath == "ReplicatedStorage/a.spec", "T9: the first file")
	check(
		published[#published].testFilePath == "ReplicatedStorage/b.spec",
		"T9: and the second file"
	)
	check(first.handlerCount() == 1, "T9: one handler on the first file's list")
	check(second.handlerCount() == 1, "T9: one handler on the second file's list")
end

-- T10: disarming stops the standing patch publishing, so a run that wants no
-- heartbeat does not keep writing into the last run's map.
local function testDisarmStopsPublishing()
	local matcher = { currentTestName = nil, testPath = nil }
	local published: { any } = {}
	local armed = TestProgress.arm({
		circusState = CIRCUS_STATE_MODULE,
		getMatcherState = function()
			return matcher
		end,
		publish = function(entry: any)
			table.insert(published, entry)
		end,
		runtimeClass = RuntimeClass,
	})

	TestProgress.disarm(armed)
	local circus = runTestFile(matcher, makeSpecFile("c.spec"), { "c one" })

	check(#published == 0, "T10: a disarmed run publishes nothing")
	check(circus.handlerCount() == 0, "T10: and installs no handler")
end

testPublishesFirstTest()
testThrottlesWithinAFile()
testPublishesAfterTheWindow()
testAlwaysPublishesANewFile()
testPublishesCompletion()
testIgnoresOtherEvents()
testSwallowsErrors()
testPublishesFileWithoutATest()
testInstallsInEveryTestFile()
testDisarmStopsPublishing()

print("ALL OK")
