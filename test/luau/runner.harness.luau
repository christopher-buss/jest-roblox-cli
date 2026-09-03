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
local jestMissing = {}

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

local JestModule = makeInstance("Jest")
local CircusStateModule = makeInstance("state")
local CircusModule =
	makeInstance("JestCircus", { circus = makeInstance("circus", { state = CircusStateModule }) })
local ExpectModule = makeInstance("Expect")
local RuntimeModule = makeInstance("JestRuntime")

local Jest = {
	runCLI = function(_, config, projects)
		local project = projects[1]
		return {
			expect = function()
				jestSawConfig = config
				emit("jest:" .. project, OUTPUT)
				if jestFails[project] then
					error("jest exploded in " .. project, 0)
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
		findSiblingPackage = function(_module, name)
			if name == "JestCircus" then
				return CircusModule
			end

			return if name == "JestRuntime" then RuntimeModule else ExpectModule
		end,
	},
	["./intercept-writeable"] = {
		intercept = function()
			return function() end
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

-- The real capture, watchdog and result seam, so what this file drives is what
-- production runs: the capture window and the abandon verdict are the subject
-- of the assertions below, and the seam is where both envelope halves are
-- decided.
stubs["./game-output-capture"] = __CAPTURE_MODULE__
stubs["./infinite-yield"] = __INFINITE_YIELD_MODULE__
stubs["./runner-result"] = __RUNNER_RESULT_MODULE__

local Runner = __MODULE__

local function reset()
	jestFails = {}
	jestParks = {}
	jestMissing = {}
	jestSawConfig = nil
	armed = {}
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
	check(failed.runner == nil, "T2: a run that failed on its own names no abandon reason")
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
	check(outputOf(entries[2]).success == true, "T4: the next config still runs")
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
testElapsedBudgetAbandonsOnlyItsConfig()
testWithinBudgetNamesNoReason()
testRunnerFlagsAreStripped()
testHooksFireAroundEveryConfig()
testFailedInjectionStillCleansUp()
testFailedCleanupDoesNotEndTheBatch()

print("ALL OK")
