--!nocheck
-- Lute-driven test for the multi-mode runner's per-config dispatch. The runner
-- and the three modules it shares with the workspace runner — the Game Output
-- capture, the watchdog and the result seam — are inlined into the
-- placeholders below by runner.spec.ts; the fake `game`, `require`, `task` and
-- `warn` declared here are the upvalues they close over, so every other
-- sibling module is a stub defined in this file. Any failed assertion calls
-- error(), failing the wrapper spec.
--
-- What this covers is the loop `runProjects` runs, which until now only e2e
-- reached: which config gets which entry, what a config that fails reports,
-- and that the hooks fire around each one either way.

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- Fake LogService.MessageOut: `emit` is what the stubbed Jest calls in place
-- of print/warn.
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

-- Deadlines the watchdog has armed and the clock has not reached; `elapse`
-- below is the clock reaching them. Nothing advances on its own, so a test
-- says exactly when a config runs out of budget.
local armed = {}

local task = {
	spawn = function(target, ...)
		local thread = if type(target) == "thread" then target else coroutine.create(target)
		local ok, err = coroutine.resume(thread, ...)
		if not ok then
			fail("task.spawn thread errored: " .. tostring(err))
		end

		return thread
	end,
	delay = function(seconds: number, callback)
		local thread = coroutine.create(callback)
		table.insert(armed, { seconds = seconds, thread = thread })
		return thread
	end,
	cancel = function(target)
		for index, entry in armed do
			if entry.thread == target then
				table.remove(armed, index)
				coroutine.close(target)
				return
			end
		end

		fail("task.cancel: thread is not armed")
	end,
}

local function elapse()
	local due = armed
	armed = {}
	for _, entry in due do
		local ok, err = coroutine.resume(entry.thread)
		if not ok then
			fail("deadline thread errored: " .. tostring(err))
		end
	end
end

local function emit(message: string, messageType)
	for _, handler in listeners do
		handler(message, messageType)
	end
end

-- JSONEncode hands out a token and remembers the value behind it, so the
-- assertions below read an encoded envelope back without a JSON codec.
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

local services = {
	HttpService = HttpService,
	LogService = { MessageOut = MessageOut },
}

local game = {}

function game:GetService(name: string)
	local service = services[name]
	check(service ~= nil, "GetService: no such service " .. name)
	return service
end

local function warn() end

-- Shadows the real (readonly, under lute) global the coverage probes write
-- into, so the result seam's own sink reset lands in a table this file can
-- read.
local _G = {}

-- Per-project scripted behaviour, keyed by the project path the config names.
local jestFails = {}
local jestParks = {}
local jestHangs = {}
local jestMissing = {}
-- The engine warning a `WaitForChild` on an absent instance produces, which is
-- the other thing that ends a run the engine will not.
local YIELD_WARNING = "Infinite yield possible on 'ReplicatedStorage.shared:WaitForChild(\"x\")'"
-- What a config writes to Jest's own stdout on its way out, the way the real
-- "No tests found, exiting with code 1" is written.
local jestBanners = {}

-- The config Jest was last handed, so a test can tell what the runner stripped
-- before handing it over.
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

-- A service-rooted spec file, for the last-seen record to name a test in. The
-- topmost fake (Parent = nil) stands in for `game` and is left off the path.
local function makeSpecFile(name: string): any
	local root = { Name = "game", Parent = nil }
	local replicatedStorage = { Name = "ReplicatedStorage", Parent = root }

	return { Name = name, Parent = replicatedStorage }
end

-- Expect's matcher state, which is where both per-file hooks read the running
-- test's identity from. Shared across the run the way `_G` shares it.
local matcherState: any = { currentTestName = nil, testPath = nil }

-- jest-runtime's shared class table. Handed back by identity rather than
-- rebuilt per require, because the circus hook patches `setGlobalsForRuntime`
-- on it and a fresh table each time would drop the patch.
local RuntimeClass: any = {}

function RuntimeClass.setGlobalsForRuntime() end

-- One test file's own circus dispatch list, the way jest's per-file module
-- registry gives each file a list of its own.
local function makeCircusState()
	local handlers: { any } = {}

	return {
		addEventHandler = function(handler: any)
			table.insert(handlers, handler)
		end,
		dispatch = function(name: string)
			for _, handler in handlers do
				handler(nil, { name = name })
			end
		end,
	}
end

-- What jest does around one test file: a fresh runtime whose registry holds
-- that file's circus state, the `setGlobalsForRuntime` callback circus's
-- `initialize` makes, then the file's cases.
local function reachTest(fileName: string, caseName: string)
	local circusState = makeCircusState()
	local runtime = {
		requireInternalModule = function()
			return circusState
		end,
	}

	matcherState.testPath = makeSpecFile(fileName)
	RuntimeClass.setGlobalsForRuntime(runtime, {})
	matcherState.currentTestName = caseName
	circusState.dispatch("test_start")
end

local JestModule = makeInstance("Jest")
local CircusStateModule = makeInstance("state")
local CircusModule =
	makeInstance("JestCircus", { circus = makeInstance("circus", { state = CircusStateModule }) })
local ExpectModule = makeInstance("Expect")
local RuntimeModule = makeInstance("JestRuntime")
local RobloxSharedModule = makeInstance("RobloxShared")

-- Shaped like @rbxts-js/roblox-shared's Writeable: a _writeFn the tap swaps
-- out, defaulting to the print that puts the same line in Game Output.
local function makeWriteable(): any
	local writeable = { _writeFn = print }
	function writeable:write(data: string)
		self._writeFn(data)
	end

	return writeable
end

local RobloxSharedExports = {
	nodeUtils = { process = { stderr = makeWriteable(), stdout = makeWriteable() } },
}

-- Stands the RobloxShared package down, so the output tap cannot be installed.
local sharedIsMissing = false

-- `print` reaches `MessageOut` deferred: the engine hands the line to the
-- listeners a scheduler turn later, which for an abandoned config is already
-- inside the NEXT config's capture window. Queued here and flushed as the next
-- config's Jest starts, so this file reproduces the ordering that files a real
-- run's record under the wrong project.
local writeStdout = print
local deferredPrints = {}
local flushedPrints = {}

local function print(message: string)
	table.insert(deferredPrints, message)
end

local function flushPrints()
	local queued = deferredPrints
	deferredPrints = {}
	for _, message in queued do
		table.insert(flushedPrints, message)
		emit(message, OUTPUT)
	end
end

local Jest = {
	runCLI = function(_, config, projects)
		local project = projects[1]
		return {
			expect = function()
				-- The scheduler turn the previous config never got: whatever it
				-- printed on its way out arrives now, inside this capture.
				flushPrints()
				jestSawConfig = config
				emit("jest:" .. project, OUTPUT)
				-- Stands in for circus reaching a test: the per-file hook goes
				-- in from the runtime callback, and the record then names the
				-- case that is running if this config is abandoned.
				reachTest(project .. ".spec", project .. " wedges")
				local banner = jestBanners[project]
				if banner then
					RobloxSharedExports.nodeUtils.process.stdout:write(banner)
				end

				if jestFails[project] then
					error("jest exploded in " .. project, 0)
				end

				-- What a `WaitForChild` for an instance the place never had
				-- does: the engine warns five seconds in, and the thread never
				-- comes back.
				if jestHangs[project] then
					emit(YIELD_WARNING, WARNING)
					coroutine.yield()
					fail("the parked project was resumed")
				end

				if jestParks[project] then
					coroutine.yield()
					fail("the abandoned project was resumed")
				end

				return { success = true, project = project }
			end,
			cancel = function() end,
		}
	end,
}

local stubs = {
	["./instance-resolver"] = {
		getJest = function(config)
			local project = config.projects[1]
			if jestMissing[project] then
				emit("missing:" .. project, WARNING)
				error("Failed to find Jest instance for " .. project, 0)
			end

			return JestModule
		end,
		findInstance = function(path)
			return path
		end,
		findRobloxShared = function()
			return if sharedIsMissing then nil else RobloxSharedModule
		end,
		findSiblingPackage = function(_module, name)
			if name == "JestCircus" then
				return CircusModule
			end

			return if name == "JestRuntime" then RuntimeModule else ExpectModule
		end,
	},
	["./phase-timing"] = {
		build = function()
			return nil
		end,
	},
	["./promise-error"] = {
		normalize = function(err)
			return tostring(err)
		end,
	},
	["./setup-timing"] = {
		patch = function()
			return nil
		end,
		unpatch = function() end,
		getSeconds = function()
			return 0
		end,
	},
	["./snapshot-patch"] = {
		patch = function()
			return nil
		end,
		unpatch = function() end,
	},
	-- Reached through the shared result seam, which resolves the run's own
	-- jest-circus / Expect / jest-runtime packages before arming.
	["./per-test-coverage"] = {
		arm = function()
			return { failure = nil, records = {} }
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

	if target == RobloxSharedModule then
		return RobloxSharedExports
	end

	if target == ExpectModule then
		return {
			getState = function()
				return matcherState
			end,
		}
	end

	if target == RuntimeModule then
		return RuntimeClass
	end

	local stub = stubs[target]
	check(stub ~= nil, "unstubbed require: " .. tostring(target))
	return stub
end

-- The real capture, watchdog and result seam, so what this file drives is what
-- production runs: the capture window and the abandon verdict are the subject
-- of the assertions below, and the seam is where both envelope halves are
-- decided.
-- The real tap and the real installer that reaches for it, assigned before
-- the modules requiring them are inlined below: each of those bodies runs
-- where it is written.
stubs["./intercept-writeable"] = __INTERCEPT_WRITEABLE_MODULE__
stubs["./process-capture"] = __PROCESS_CAPTURE_MODULE__
stubs["./game-output-capture"] = __CAPTURE_MODULE__
stubs["./infinite-yield"] = __INFINITE_YIELD_MODULE__
-- Real too, and reached through the result seam: what the abort says about the
-- test it died in is the subject of the assertions below, so a stub here would
-- only assert that a string was concatenated.
stubs["./last-seen"] = __LAST_SEEN_MODULE__
stubs["./runner-result"] = __RUNNER_RESULT_MODULE__

local Runner = __MODULE__

local function reset()
	jestFails = {}
	jestParks = {}
	jestHangs = {}
	jestMissing = {}
	jestBanners = {}
	jestSawConfig = nil
	armed = {}
	deferredPrints = {}
	flushedPrints = {}
end

-- A config the way the CLI sends one: the project path is what a test scripts
-- its behaviour against.
local function configFor(project: string, budgetMs: number?)
	return {
		projects = { project },
		runnerCoverage = false,
		runnerPerTestCoverage = false,
		runnerTimeoutMs = budgetMs,
		runnerTiming = false,
	}
end

local function outputOf(entry)
	return HttpService:JSONDecode(entry.jestOutput)
end

local function messagesOf(entry)
	local decoded = if entry.gameOutput then HttpService:JSONDecode(entry.gameOutput) else {}
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

-- The last-seen line carries an elapsed time this file does not fix, so it is
-- matched on the part that names the test.
local function hasPart(messages, wanted: string): boolean
	for _, message in messages do
		if string.find(message, wanted, 1, true) ~= nil then
			return true
		end
	end

	return false
end

-- Drives a batch from a thread the harness owns, so a batch that parks on a
-- config can be resumed here the way the elapsed budget resumes it in
-- production. `done` stays false while the batch is parked.
local function runInThread(fn)
	local outcome = { done = false }
	local thread = coroutine.create(function()
		outcome.entries = fn()
		outcome.done = true
	end)

	local ok, err = coroutine.resume(thread)
	check(ok, "batch thread errored: " .. tostring(err))
	return outcome
end

-- T1: every config gets an entry, at the index it was requested at, carrying
-- its own run's result and its own capture window.
local function testEveryConfigGetsItsOwnEntry()
	reset()
	local entries = Runner.runProjects({}, { configFor("alpha"), configFor("beta") })

	check(#entries == 2, "T1: one entry per config")
	check(outputOf(entries[1]).value.project == "alpha", "T1: the first entry is the first config")
	check(outputOf(entries[2]).value.project == "beta", "T1: the second is the second")
	check(has(messagesOf(entries[1]), "jest:alpha"), "T1: each entry keeps its own output")
	check(not has(messagesOf(entries[1]), "jest:beta"), "T1: and none of the next config's")
end

-- T2: a config whose Jest rejects reports through the shared result seam, so
-- the host reads a failed multi run exactly as it reads a failed workspace one.
local function testJestRejectionIsAFailureEnvelope()
	reset()
	jestFails.alpha = true
	local entries = Runner.runProjects({}, { configFor("alpha"), configFor("beta") })

	local failed = outputOf(entries[1])
	check(failed.success == false, "T2: the failing config reports a failure")
	check(
		string.find(tostring(failed.err), "jest exploded in alpha", 1, true) ~= nil,
		"T2: the cause travels with it"
	)
	check(failed.runner.abandon == nil, "T2: a run that failed on its own names no abandon reason")
	check(failed.runner.phase == "run", "T2: it names the phase it failed in")
	check(failed.runner.captureInstalled == true, "T2: and says its stdout was being watched")
	check(outputOf(entries[2]).success == true, "T2: the batch runs on past it")
end

-- T3: a config with no Jest to find fails before the run starts, and the
-- engine warnings from the lookup still reach its capture — the window opens
-- at the top of the run for exactly this.
local function testMissingJestFailsBeforeTheRun()
	reset()
	jestMissing.alpha = true
	local entries = Runner.runProjects({}, { configFor("alpha") })

	local failed = outputOf(entries[1])
	check(failed.success == false, "T3: a config with no Jest is a failure")
	check(has(messagesOf(entries[1]), "missing:alpha"), "T3: the lookup's warning is captured")
	check(failed.runner.phase == "resolveJest", "T3: it names the phase it never got past")
	check(failed.runner.captureInstalled == nil, "T3: and answers nothing about an unattempted tap")
end

-- T3b: what Jest writes to its own stdout reaches Banner Output — that is where
-- the cause of an exit lives, written through process.stdout rather than
-- through the print LogService hears. A tree the installer cannot find
-- RobloxShared in says so, rather than reporting an empty capture as silence.
local function testJestStdoutReachesBannerOutput()
	reset()
	jestBanners.alpha = "No tests found in alpha"
	jestFails.alpha = true
	local entries = Runner.runProjects({}, { configFor("alpha") })

	local records = HttpService:JSONDecode(entries[1].bannerOutput)
	check(#records == 1, "T3b: one record per write")
	check(records[1].message == "No tests found in alpha", "T3b: carrying what Jest wrote")

	sharedIsMissing = true
	local unwatched = Runner.runProjects({}, { configFor("alpha") })
	sharedIsMissing = false

	check(
		outputOf(unwatched[1]).runner.captureInstalled == false,
		"T3b: a tap that never went on is reported as such"
	)
end

-- T4: a config still running when its budget elapses is abandoned, and the
-- envelope names the budget as what ended it rather than reporting a suite
-- that threw. Only that config: the batch runs on.
local function testElapsedBudgetAbandonsOnlyItsConfig()
	reset()
	jestParks.alpha = true

	local outcome = runInThread(function()
		return Runner.runProjects({}, { configFor("alpha", 5000), configFor("beta", 5000) })
	end)

	check(not outcome.done, "T4: the batch waits while the config is within budget")

	elapse()
	jestParks.alpha = nil

	local entries = outcome.entries
	check(outcome.done, "T4: the elapsed budget resumes the batch")
	check(#entries == 2, "T4: the batch runs on past the abandoned config")

	local abandoned = outputOf(entries[1])
	check(abandoned.success == false, "T4: an abandoned config is a failure")
	check(abandoned.runner.abandon == "timeout", "T4: and the budget is what ended it")
	check(
		string.find(tostring(abandoned.err), "Timed out after 5s", 1, true) ~= nil,
		"T4: the failure names the budget"
	)
	check(
		string.find(
			tostring(abandoned.err),
			'Last test seen: "alpha wedges" in ReplicatedStorage/alpha.spec (running for',
			1,
			true
		) ~= nil,
		"T4: and the test it was in, got " .. tostring(abandoned.err)
	)
	check(outputOf(entries[2]).success == true, "T4: the next config still runs")
end

-- T4b: the other way a run is abandoned names the test too — a config parked
-- on a `WaitForChild` the place cannot satisfy reports the warning and the
-- test the run had reached, not one or the other.
local function testInfiniteYieldNamesTheTest()
	reset()
	jestHangs.alpha = true

	local entries = Runner.runProjects({}, { configFor("alpha") })

	local abandoned = outputOf(entries[1])
	check(abandoned.success == false, "T4b: a parked config is a failure")
	check(abandoned.runner.abandon == nil, "T4b: a yield is not the budget running out")
	check(
		string.find(tostring(abandoned.err), "Infinite yield detected", 1, true) ~= nil,
		"T4b: the failure names the yield"
	)
	check(
		string.find(
			tostring(abandoned.err),
			'Last test seen: "alpha wedges" in ReplicatedStorage/alpha.spec (running for',
			1,
			true
		) ~= nil,
		"T4b: and the test it was in, got " .. tostring(abandoned.err)
	)
end

-- T4c: the record is filed under the config it is about. Left to the print
-- alone it is not: `MessageOut` delivers deferred, so the line arrives after
-- the abandoned config's capture has closed and inside the next config's, which
-- is where a real run put it.
local function testTheRecordLandsInTheAbandonedConfigsOutput()
	reset()
	jestParks.alpha = true

	local outcome = runInThread(function()
		return Runner.runProjects({}, { configFor("alpha", 5000), configFor("beta", 5000) })
	end)

	elapse()
	jestParks.alpha = nil

	local entries = outcome.entries
	local note = 'Last test seen: "alpha wedges" in ReplicatedStorage/alpha.spec'
	check(hasPart(flushedPrints, note), "T4c: the run still prints the record")
	check(
		hasPart(messagesOf(entries[1]), note),
		"T4c: the abandoned config's own Game Output carries it"
	)
	check(
		not hasPart(messagesOf(entries[2]), note),
		"T4c: and the config that ran next carries it nowhere"
	)
end

-- T4d: a note with no capture open files nothing, so it drops nothing later.
-- The echo drop is cleared by the deferred `MessageOut` the note's own print
-- fires; with no capture open there is no listener to clear it, and the slot
-- would outlive the print and swallow the next capture's first matching line.
-- Multi mode reaches this whenever a parallel VM host owns the capture.
local function testNoteWithNoCaptureOpenDropsNothingLater()
	reset()
	local Capture = stubs["./game-output-capture"]
	local line = 'Last test seen: "gamma wedges" in ReplicatedStorage/gamma.spec'

	Capture.note(line)
	flushPrints()

	local stopCapture = Capture.start()
	emit(line, OUTPUT)
	local captured = stopCapture()

	check(captured ~= nil, "T4d: the later capture reported something")
	check(
		has(messagesOf({ gameOutput = captured }), line),
		"T4d: and kept its byte-identical line"
	)
end

-- T5: a config that finished inside its budget names no abandon reason, so the
-- field stays absent rather than riding on every envelope as one that did not
-- apply.
local function testWithinBudgetNamesNoReason()
	reset()
	local entries = Runner.runProjects({}, { configFor("alpha", 5000) })

	local decoded = outputOf(entries[1])
	check(decoded.success == true, "T5: the config passed")
	check(decoded.runner == nil, "T5: a config within budget names no abandon reason")
end

-- T6: the runner's own keys are stripped before Jest.runCLI, so the config
-- Jest validates holds nothing it does not know about.
local function testRunnerFlagsAreStripped()
	reset()
	Runner.runProjects({}, { configFor("alpha", 5000) })

	check(jestSawConfig ~= nil, "T6: Jest ran")
	check(jestSawConfig.runnerTiming == nil, "T6: the timing flag is stripped")
	check(jestSawConfig.runnerCoverage == nil, "T6: the coverage flag is stripped")
	check(jestSawConfig.runnerPerTestCoverage == nil, "T6: the attribution flag is stripped")
	check(jestSawConfig.runnerTimeoutMs == nil, "T6: the budget is stripped")
	check(jestSawConfig.runnerCaptureGameOutput == nil, "T6: the capture flag is stripped")
end

-- T7: the hooks fire around each config in turn, and `afterConfig` fires even
-- for a config whose run failed — the stubs it parented have to come out
-- before the next config's go in, whatever happened in between.
local function testHooksFireAroundEveryConfig()
	reset()
	jestFails.beta = true
	local calls = {}

	Runner.runProjects({}, { configFor("alpha"), configFor("beta") }, {
		beforeConfig = function(_cfg, index)
			table.insert(calls, "before:" .. index)
		end,
		afterConfig = function(_cfg, index)
			table.insert(calls, "after:" .. index)
		end,
	})

	check(
		table.concat(calls, ",") == "before:1,after:1,before:2,after:2",
		"T7: each config is bracketed by its own hooks, in order"
	)
end

-- T8: a `beforeConfig` that throws mid-injection still gets its `afterConfig`,
-- so partially-parented stubs are destroyed rather than leaking into the next
-- config's run. The config it failed for reports the injection error.
local function testFailedInjectionStillCleansUp()
	reset()
	local cleaned = {}

	local entries = Runner.runProjects({}, { configFor("alpha") }, {
		beforeConfig = function()
			error("could not parent the stub", 0)
		end,
		afterConfig = function(_cfg, index)
			table.insert(cleaned, index)
		end,
	})

	check(#cleaned == 1, "T8: cleanup runs for a config whose injection failed")
	local reported = outputOf(entries[1])
	check(reported.success == true, "T8: the injection error rides as an execution error")
	check(
		string.find(tostring(reported.value.error), "could not parent the stub", 1, true) ~= nil,
		"T8: and it names what went wrong"
	)
end

-- T9: an `afterConfig` that throws is warned about rather than allowed to end
-- the batch — a config that ran must still be reported, and the ones behind it
-- must still run.
local function testFailedCleanupDoesNotEndTheBatch()
	reset()
	local entries = Runner.runProjects({}, { configFor("alpha"), configFor("beta") }, {
		afterConfig = function()
			error("teardown exploded", 0)
		end,
	})

	check(#entries == 2, "T9: a throwing cleanup stops neither config")
	check(outputOf(entries[1]).success == true, "T9: the first config is still reported")
	check(outputOf(entries[2]).success == true, "T9: and so is the second")
end

testEveryConfigGetsItsOwnEntry()
testJestRejectionIsAFailureEnvelope()
testMissingJestFailsBeforeTheRun()
testJestStdoutReachesBannerOutput()
testElapsedBudgetAbandonsOnlyItsConfig()
testInfiniteYieldNamesTheTest()
testTheRecordLandsInTheAbandonedConfigsOutput()
testNoteWithNoCaptureOpenDropsNothingLater()
testWithinBudgetNamesNoReason()
testRunnerFlagsAreStripped()
testHooksFireAroundEveryConfig()
testFailedInjectionStillCleansUp()
testFailedCleanupDoesNotEndTheBatch()

writeStdout("ALL OK")
