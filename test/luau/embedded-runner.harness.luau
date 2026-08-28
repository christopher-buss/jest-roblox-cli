--!nocheck
-- Lute-driven test for the embedded workspace runner's per-package Game
-- Output capture. The runner and the capture module it shares with runner.luau
-- are inlined into the placeholders below by embedded-runner.spec.ts; the fake
-- `game`, `require` and `warn` declared here are the upvalues both close over,
-- so every other sibling module is a stub defined in this file. Any failed
-- assertion calls error(), failing the wrapper spec.

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- Fake LogService.MessageOut: `emit` is what the stubbed materializer and Jest
-- call in place of print/warn.
local listeners = {}
local MessageOut = {}

function MessageOut:Connect(handler)
	local id = {}
	listeners[id] = handler
	return {
		Disconnect = function()
			listeners[id] = nil
		end,
	}
end

local OUTPUT = { Value = 0 }
local WARNING = { Value = 2 }

local Enum = { MessageType = { MessageOutput = OUTPUT, MessageWarning = WARNING } }

-- Faithful enough `task.spawn`: it resumes immediately, so a thunk that never
-- yields finishes before the call returns.
local task = {
	spawn = function(target, ...)
		local thread = if type(target) == "thread" then target else coroutine.create(target)
		local ok, err = coroutine.resume(thread, ...)
		if not ok then
			fail("task.spawn thread errored: " .. tostring(err))
		end

		return thread
	end,
}

local function emit(message: string, messageType)
	for _, handler in listeners do
		handler(message, messageType)
	end
end

-- JSONEncode hands out a token and remembers the value behind it, so the
-- assertions below read the encoded Game Output back without a JSON codec.
local encoded = {}
local encodeCount = 0
local HttpService = {}

function HttpService:JSONEncode(value)
	encodeCount += 1
	local token = "json#" .. encodeCount
	encoded[token] = value
	return token
end

function HttpService:JSONDecode(token)
	return encoded[token]
end

-- MemoryStore stand-in. `queueItems` is what the work-stealing loop pops;
-- `sortedMaps` is keyed by id so a test can plant a sibling's bail signal.
local queueItems = {}
local sortedMaps = {}

local function sortedMapFor(id: string)
	local existing = sortedMaps[id]
	if existing ~= nil then
		return existing
	end

	local map = { items = {} }
	function map:GetAsync(key: string)
		return self.items[key]
	end
	function map:SetAsync(key: string, value, _ttl: number)
		self.items[key] = value
		return true
	end

	sortedMaps[id] = map
	return map
end

local MemoryStoreService = {}

function MemoryStoreService:GetQueue()
	return {
		ReadAsync = function()
			local item = table.remove(queueItems, 1)
			return if item == nil then {} else { item }, item
		end,
		RemoveAsync = function() end,
	}
end

function MemoryStoreService:GetSortedMap(id: string)
	return sortedMapFor(id)
end

local services = {
	HttpService = HttpService,
	LogService = { MessageOut = MessageOut },
	MemoryStoreService = MemoryStoreService,
}

local game = {}

function game:GetService(name: string)
	local service = services[name]
	check(service ~= nil, "GetService: no such service " .. name)
	return service
end

local function warn() end

-- Shadows the real (readonly, under lute) global the coverage probes write
-- into, so the runner's own sink reset lands in a table this file can read.
local _G = {}

-- Per-package scripted behaviour: whether the materializer or Jest fails, or
-- whether the package prints nothing at all.
local materializeFails = {}
local jestFails = {}
local jestRedTests = {}
local jestMissing = {}
local silent = {}
local jestHangs = {}

local YIELD_WARNING = "Infinite yield possible on 'ReplicatedStorage.shared:WaitForChild(\"x\")'"

local function say(pkg: string, message: string, messageType)
	if not silent[pkg] then
		emit(message, messageType)
	end
end

-- The accumulator the per-test coverage hook hands back on install, and the
-- config Jest was last handed — both written by the stubs below and read by
-- the coverage tests.
local liveRecords: any = nil
local jestSawConfig: any = nil

local function makeInstance(name: string, children: any?): any
	local instance = { Name = name, children = children or {} }

	function instance:FindFirstChild(childName: string)
		return self.children[childName]
	end

	function instance:IsA(className: string)
		return className == "ModuleScript"
	end

	return instance
end

local JestModule = makeInstance("Jest")
-- Shaped like the real package: `addEventHandler` lives on `circus/state`, not
-- on the root the runner resolves first.
local CircusStateModule = makeInstance("state")
local CircusModule =
	makeInstance("JestCircus", { circus = makeInstance("circus", { state = CircusStateModule }) })
local ExpectModule = makeInstance("Expect")
local RuntimeModule = makeInstance("JestRuntime")
local Jest = {
	runCLI = function(_, config)
		return {
			expect = function()
				local pkg = config.pkg
				jestSawConfig = config
				say(pkg, "jest:" .. pkg, OUTPUT)
				say(pkg, "warn:" .. pkg, WARNING)
				if jestFails[pkg] then
					error("jest exploded in " .. pkg, 0)
				end

				-- What a `WaitForChild` for an instance the stage never had
				-- does: the engine warns five seconds in, and the thread
				-- never comes back.
				if jestHangs[pkg] then
					emit(YIELD_WARNING, WARNING)
					coroutine.yield()
					fail("the parked package was resumed")
				end

				-- Stands in for circus firing test_done: real attribution
				-- lands in the accumulator while Jest runs, one record per
				-- test, and a probe hit lands in the sink.
				_G.__jest_roblox_cov["Packages/" .. pkg] = { 1 }
				if liveRecords ~= nil then
					table.insert(liveRecords, {
						delta = { ["Packages/" .. pkg] = { 1 } },
						testCaseId = "covers " .. pkg,
						testFilePath = "Packages/" .. pkg .. "/init.spec",
					})
				end

				return { results = { success = not jestRedTests[pkg] } }
			end,
		}
	end,
}

local stubs = {
	["../instance-resolver"] = {
		getJest = function(config)
			if jestMissing[config.pkg] then
				emit("missing:" .. config.pkg, WARNING)
				error("Failed to find Jest instance for " .. config.pkg, 0)
			end

			return JestModule
		end,
		findInstance = function(path)
			return path
		end,
		findSiblingPackage = function(_module, name)
			if name == "JestCircus" then
				return CircusModule
			end

			return if name == "JestRuntime" then RuntimeModule else ExpectModule
		end,
	},
	["../intercept-writeable"] = {
		intercept = function()
			return function() end
		end,
	},
	["./materializer"] = {
		materialize = function(pkg)
			say(pkg, "materialize:" .. pkg, OUTPUT)
			if materializeFails[pkg] then
				error("no stage for " .. pkg, 0)
			end
		end,
		reset = function()
			emit("reset", WARNING)
		end,
	},
	["../phase-timing"] = {
		build = function()
			return nil
		end,
	},
	["../promise-error"] = {
		normalize = function(err)
			return tostring(err)
		end,
	},
	["./result-budget"] = {
		new = function()
			return {}
		end,
		shouldStop = function()
			return false
		end,
		add = function() end,
		measure = function()
			return 0
		end,
	},
	["../setup-timing"] = {
		patch = function()
			return nil
		end,
		unpatch = function() end,
		getSeconds = function()
			return 0
		end,
	},
	["../snapshot-patch"] = {
		patch = function()
			return nil
		end,
		unpatch = function() end,
	},
	-- Reached through the shared runner-result module, which resolves the
	-- run's own jest-circus / Expect / jest-runtime packages before arming.
	["./per-test-coverage"] = {
		arm = function()
			liveRecords = {}
			return { failure = nil, records = liveRecords }
		end,
		disarm = function() end,
	},
}

local function require(target)
	if target == JestModule then
		return Jest
	end

	if target == CircusModule then
		return { getState = function() end, run = function() end }
	end

	if target == CircusStateModule then
		return { addEventHandler = function() end }
	end

	if target == ExpectModule then
		return {
			getState = function()
				return {}
			end,
		}
	end

	if target == RuntimeModule then
		return { setGlobalsForRuntime = function() end }
	end

	local stub = stubs[target]
	check(stub ~= nil, "unstubbed require: " .. tostring(target))
	return stub
end

-- The real capture module, so the window under test is the one production
-- runs. Its own `require("./intercept-writeable")` only wants the type.
stubs["./intercept-writeable"] = stubs["../intercept-writeable"]
stubs["../game-output-capture"] = __CAPTURE_MODULE__
-- The real bail module too: it decides when a loop stops taking packages,
-- which is what the bail assertions below are about.
stubs["./bail"] = __BAIL_MODULE__
-- The real result builder as well: it is the seam both runners assemble their
-- `runner` envelope through, so a workspace run must reach the same fields a
-- multi run does. Its instance-resolver sits at the luau root, not beside the
-- staging runner, so it asks under a different path than the runner does.
stubs["./instance-resolver"] = stubs["../instance-resolver"]
stubs["../runner-result"] = __RUNNER_RESULT_MODULE__
-- The real watchdog too: what it does to a package that parks is the subject of
-- the infinite-yield assertion below.
stubs["../infinite-yield"] = __INFINITE_YIELD_MODULE__

local EmbeddedRunner = __MODULE__

local function entryFor(pkg: string)
	-- `pkg` rides on the config so the Jest stub knows whose run it is.
	return { pkg = pkg, project = "unit", config = { pkg = pkg } }
end

local function messagesOf(result)
	local decoded = if result.gameOutput then HttpService:JSONDecode(result.gameOutput) else {}
	local messages = {}
	for _, record in decoded do
		table.insert(messages, record.message)
	end

	return messages
end

local function has(messages, wanted: string): boolean
	for _, message in messages do
		if message == wanted then
			return true
		end
	end

	return false
end

local function run(pkgs)
	local entries = {}
	for _, pkg in pkgs do
		table.insert(entries, entryFor(pkg))
	end

	return EmbeddedRunner.runEmbedded({}, { entries = entries })
end

local function runBailing(pkgs)
	local entries = {}
	for _, pkg in pkgs do
		table.insert(entries, entryFor(pkg))
	end

	return EmbeddedRunner.runEmbedded({}, { bail = true, entries = entries })
end

local function runStealing(pkgs, payload)
	local entries = {}
	queueItems = {}
	for _, pkg in pkgs do
		table.insert(entries, entryFor(pkg))
		table.insert(queueItems, { pkg = pkg, project = "unit" })
	end

	local full = { entries = entries, invisibilityWindowSeconds = 90, queueId = "q" }
	for key, value in payload do
		full[key] = value
	end

	return EmbeddedRunner.runWorkStealing({}, full)
end

-- T1: the capture opens before the package is materialized and spans its run,
-- and two packages that each print distinct messages get only their own —
-- including the reset between them, which belongs to neither capture.
local function testWindowAndNoBleedAcrossPackages()
	local results = run({ "a", "b" })
	local a = messagesOf(results[1])
	local b = messagesOf(results[2])

	check(has(a, "materialize:a") and has(a, "jest:a"), "T1: a has its own output")
	check(not has(a, "materialize:b") and not has(a, "jest:b"), "T1: a has none of b's output")
	check(has(b, "materialize:b") and has(b, "jest:b"), "T1: b has its own output")
	check(not has(b, "materialize:a") and not has(b, "jest:a"), "T1: b has none of a's output")
	check(not has(a, "reset") and not has(b, "reset"), "T1: reset output is attributed to neither")
end

-- T2: every record carries the message, its type and a timestamp.
local function testRecordShape()
	local results = run({ "a" })
	local decoded = HttpService:JSONDecode(results[1].gameOutput)

	local sawWarning = false
	for _, record in decoded do
		check(type(record.message) == "string", "T2: message is a string")
		check(type(record.messageType) == "number", "T2: messageType is a number")
		check(type(record.timestamp) == "number", "T2: timestamp is a number")
		if record.message == "warn:a" then
			sawWarning = record.messageType == 2
		end
	end

	check(sawWarning, "T2: warning records keep their message type")
end

-- T3: every failure path — a missing stage, a Jest rejection, a runner failure
-- before Jest is even found (no interception installed yet) — still returns
-- what was printed on the way down, as a per-package failure.
local FAILURE_CASES = {
	{ flags = materializeFails, pkg = "c", wanted = "materialize:c", label = "stage failure" },
	{ flags = jestFails, pkg = "d", wanted = "warn:d", label = "Jest rejection" },
	{ flags = jestMissing, pkg = "e", wanted = "missing:e", label = "runner failure" },
}

local function testFailuresKeepOutput()
	for _, case in FAILURE_CASES do
		case.flags[case.pkg] = true
		local results = run({ case.pkg })
		case.flags[case.pkg] = nil

		local decoded = HttpService:JSONDecode(results[1].jestOutput)
		check(decoded.success == false, "T3: " .. case.label .. " is a per-package failure")
		check(has(messagesOf(results[1]), case.wanted), "T3: " .. case.label .. " keeps its output")
	end
end

-- T4: a package that printed nothing has no Game Output at all, so the
-- envelope does not grow an empty field per silent package.
local function testSilentPackageHasNoOutput()
	silent.f = true
	local results = run({ "f" })
	silent.f = nil

	check(results[1].gameOutput == nil, "T4: silent package has no gameOutput")
end

-- T5: --bail stops the sequential walk at the first package whose TESTS
-- failed — Jest itself returned, so nothing errored; only the result did.
local function testBailStopsTheWalk()
	jestRedTests.a = true
	local results, outcome = runBailing({ "a", "b", "c" })
	jestRedTests.a = nil

	check(#results == 1, "T5: the walk stops after the failing package")
	check(results[1].pkg == "a", "T5: the failing package is still reported")
	check(outcome.bailed, "T5: the outcome says it bailed")
	check(not outcome.deferred, "T5: a bail is not a deferral — no replacement task")
end

-- T6: without --bail the same failure changes nothing; every package runs.
local function testFailureWithoutBailRunsOn()
	jestRedTests.a = true
	local results, outcome = run({ "a", "b", "c" })
	jestRedTests.a = nil

	check(#results == 3, "T6: no --bail runs every package")
	check(not outcome.bailed, "T6: no --bail never reports a bail")
end

-- T7: the same stop applies to the work-stealing loop, and the trip is
-- broadcast so siblings draining the same queue see it.
local function testBailStopsThePopLoop()
	jestRedTests.a = true
	local results, outcome = runStealing({ "a", "b", "c" }, { bail = true, bailMapId = "bail-map" })
	jestRedTests.a = nil

	check(#results == 1, "T7: the pop loop stops after the failing package")
	check(outcome.bailed, "T7: the outcome says it bailed")
	check(sortedMaps["bail-map"] ~= nil, "T7: the trip is broadcast to the signal map")
	check(next(sortedMaps["bail-map"].items) ~= nil, "T7: the signal map holds a signal")
	check(#queueItems == 2, "T7: the packages it never reached stay in the queue")
end

-- T8: a sibling's signal stops this task before it pops anything at all —
-- the check runs ahead of the read, not after the run.
local function testSiblingSignalStopsBeforeFirstPop()
	sortedMaps["sibling-map"] = nil
	local planted = sortedMapFor("sibling-map")
	planted:SetAsync("signal", { bailed = true }, 600)

	local results, outcome = runStealing({ "a", "b" }, { bail = true, bailMapId = "sibling-map" })

	check(#results == 0, "T8: a task that sees a sibling's signal takes nothing")
	check(outcome.bailed, "T8: the outcome says it bailed")
	check(#queueItems == 2, "T8: it leaves the queue untouched")
end

-- T9: the pop loop without --bail drains the queue even when a package fails.
local function testPopLoopWithoutBailDrains()
	jestRedTests.a = true
	local results, outcome = runStealing({ "a", "b" }, {})
	jestRedTests.a = nil

	check(#results == 2, "T9: no --bail drains the queue")
	check(not outcome.bailed, "T9: no --bail never reports a bail")
end

-- The workspace shape of a coverage run: the host sets both flags on every
-- entry's config when `collectPerTestCoverage` is on.
local function coveredEntryFor(pkg: string)
	return {
		pkg = pkg,
		project = "unit",
		config = { pkg = pkg, runnerCoverage = true, runnerPerTestCoverage = true },
	}
end

local function runCovered(pkgs)
	local entries = {}
	for _, pkg in pkgs do
		table.insert(entries, coveredEntryFor(pkg))
	end

	return EmbeddedRunner.runEmbedded({}, { entries = entries })
end

local function runnerFieldsOf(result)
	return HttpService:JSONDecode(result.jestOutput).runner
end

-- T10: a workspace run with per-test attribution on reports the records the
-- hook collected, not just the cumulative sink — the same dimensions a multi
-- run reports, so covering-test narrowing works on both.
local function testPerTestCoverageReachesTheWire()
	liveRecords = nil
	local results = runCovered({ "a" })
	local runner = runnerFieldsOf(results[1])

	check(runner ~= nil, "T10: a coverage run carries runner fields")
	check(runner.coverage["Packages/a"] ~= nil, "T10: the cumulative sink is reported")
	check(runner.perTestCoverage ~= nil, "T10: per-test attribution is reported")
	check(#runner.perTestCoverage == 1, "T10: one record per test that covered something")
	check(runner.perTestCoverage[1].testCaseId == "covers a", "T10: the record names its test")
end

-- T11: attribution is per-package, like the sink it diffs — package b's
-- records carry none of a's.
local function testPerTestCoverageIsPerPackage()
	liveRecords = nil
	local results = runCovered({ "a", "b" })

	local first = runnerFieldsOf(results[1]).perTestCoverage
	local second = runnerFieldsOf(results[2]).perTestCoverage

	check(#first == 1 and first[1].testCaseId == "covers a", "T11: a records only its own test")
	check(#second == 1 and second[1].testCaseId == "covers b", "T11: b records only its own test")
end

-- T12: both runner-only flags are stripped before Jest.runCLI, so neither
-- reaches Jest's own argv.
local function testRunnerFlagsAreStripped()
	liveRecords = nil
	jestSawConfig = nil
	runCovered({ "a" })

	check(jestSawConfig ~= nil, "T12: Jest ran")
	check(jestSawConfig.runnerCoverage == nil, "T12: the coverage flag is stripped")
	check(jestSawConfig.runnerPerTestCoverage == nil, "T12: the attribution flag is stripped")
end

-- T13: a coverage run without attribution installs no hook and reports no
-- records, so the field stays absent rather than encoding an empty list.
local function testCoverageWithoutAttribution()
	liveRecords = nil
	local entry = coveredEntryFor("a")
	entry.config.runnerPerTestCoverage = nil
	local results = EmbeddedRunner.runEmbedded({}, { entries = { entry } })
	local runner = runnerFieldsOf(results[1])

	check(liveRecords == nil, "T13: no attribution flag installs no hook")
	check(runner.coverage ~= nil, "T13: coverage is still reported")
	check(runner.perTestCoverage == nil, "T13: no attribution means no field")
end

-- T14: a package that parks on a yield nothing will ever resolve fails on its
-- own and the batch runs on. Unguarded the task holds that thread until Roblox
-- ends it on the deadline, which names neither the package nor the yield.
local function testInfiniteYieldFailsOnlyItsPackage()
	jestHangs.a = true
	local results = run({ "a", "b" })
	jestHangs.a = nil

	check(#results == 2, "T14: the batch runs on past the parked package")

	local parked = HttpService:JSONDecode(results[1].jestOutput)
	check(parked.success == false, "T14: the parked package fails")
	check(
		string.find(parked.err, "Infinite yield detected", 1, true) ~= nil,
		"T14: the failure names the infinite yield"
	)
	check(has(messagesOf(results[1]), YIELD_WARNING), "T14: the warning is kept as its output")

	local second = HttpService:JSONDecode(results[2].jestOutput)
	check(second.success == true, "T14: the next package still runs")
end

testWindowAndNoBleedAcrossPackages()
testRecordShape()
testFailuresKeepOutput()
testSilentPackageHasNoOutput()
testBailStopsTheWalk()
testFailureWithoutBailRunsOn()
testBailStopsThePopLoop()
testSiblingSignalStopsBeforeFirstPop()
testPopLoopWithoutBailDrains()
testPerTestCoverageReachesTheWire()
testPerTestCoverageIsPerPackage()
testRunnerFlagsAreStripped()
testCoverageWithoutAttribution()
testInfiniteYieldFailsOnlyItsPackage()

print("ALL OK")
