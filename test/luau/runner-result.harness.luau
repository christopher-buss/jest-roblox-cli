--!nocheck
-- Lute-driven test for the shared runner-result builder: the one seam both
-- runners assemble their `runner` envelope through, so a new result dimension
-- cannot land on one mode and miss the other. The module under test is inlined
-- into the placeholder below by runner-result.spec.ts; the fake `_G`, `require`
-- and `warn` declared here are the upvalues it closes over, so the coverage
-- sink and its jest-side dependencies stay out of Roblox. Any failed assertion
-- calls error(), failing the wrapper spec.

-- Shadows the real (readonly, under lute) global so the module's own sink
-- writes land in a table the assertions below can read.
local _G = {}

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- Jest-side stand-ins. `armedWith` records what the per-test hook was handed,
-- so the tests can tell an arm from a skip.
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

-- What the heartbeat was armed with, so the tests can tell an arm from a skip.
local progressArmedWith: any = nil
local progressArms = 0
local progressDisarms = 0

local JestModule = makeInstance("Jest")
-- Shaped like the real package: `circus/state` under a `circus` folder.
local CircusStateModule = makeInstance("state")
local CircusModule =
	makeInstance("JestCircus", { circus = makeInstance("circus", { state = CircusStateModule }) })
local ExpectModule = makeInstance("Expect")
local RuntimeModule = makeInstance("JestRuntime")

local siblingsResolve = true
local armedWith: any = nil
local disarms = 0
local nextInstallation: any = nil

local stubs = {
	["./instance-resolver"] = {
		findSiblingPackage = function(_module: any, name: string)
			if not siblingsResolve then
				return nil
			end

			if name == "JestCircus" then
				return CircusModule
			end

			return if name == "JestRuntime" then RuntimeModule else ExpectModule
		end,
	},
	["./per-test-coverage"] = {
		arm = function(options: any)
			armedWith = options
			nextInstallation = nextInstallation or { failure = nil, records = {} }
			return nextInstallation
		end,
		disarm = function()
			disarms += 1
		end,
	},
	["./test-progress"] = {
		arm = function(options: any)
			progressArmedWith = options
			progressArms += 1
			return { failure = nil }
		end,
		disarmCurrent = function()
			progressDisarms += 1
		end,
	},
}

-- The vendored package's own export shape: the root re-exports `circus/init`,
-- which forwards the run entry points and the test globals but NOT
-- `addEventHandler`. That symbol only exists on `circus/state`.
local function require(target: any)
	if target == CircusModule then
		return { getState = function() end, resetState = function() end, run = function() end }
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

local function warn()
	fail("the result builder must not degrade attribution to a warning")
end

local RunnerResult = __MODULE__

local JEST_RESULT = { numPassedTests = 3, success = true }

local function reset()
	_G.__jest_roblox_cov = nil
	armedWith = nil
	disarms = 0
	nextInstallation = nil
	progressArmedWith = nil
	progressArms = 0
	progressDisarms = 0
	siblingsResolve = true
end

-- T1: a run with no extra dimensions carries no `runner` key at all, so the
-- envelope does not grow an empty field per run.
local function testBareRunHasNoRunnerKey()
	reset()
	local payload = RunnerResult.build(JEST_RESULT, {})

	check(payload.success == true, "T1: the payload reports success")
	check(payload.value == JEST_RESULT, "T1: Jest's own result travels untouched")
	check(payload.runner == nil, "T1: no dimensions means no runner key")
end

-- T2: coverage attaches the whole sink, even empty — "the run collected
-- coverage and nothing was hit" is not the same answer as "no coverage run".
-- The sink comes off the state, so what a run reports is what that run armed,
-- whatever the global says by the time the payload is assembled.
local function testCoverageAttachesTheSink()
	reset()
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true })
	local armed = state.hits
	_G.__jest_roblox_cov = { ["Foo/later"] = { 1 } }
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(payload.runner ~= nil, "T2: coverage populates the runner key")
	check(payload.runner.coverage == armed, "T2: the sink this run armed is attached")
	check(next(payload.runner.coverage) == nil, "T2: an untouched sink stays empty")
end

-- T3: coverage off leaves the field absent even when a previous run's hits are
-- still sitting in the sink.
local function testCoverageOffAttachesNothing()
	reset()
	_G.__jest_roblox_cov = { ["Foo/bar"] = { 1 } }
	local state = RunnerResult.beginCoverage(JestModule, { coverage = false })
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(state.hits == nil, "T3: the state holds no sink")
	check(payload.runner == nil, "T3: coverage off attaches nothing")
	check(_G.__jest_roblox_cov["Foo/bar"] ~= nil, "T3: coverage off leaves the sink alone")
end

-- T4: enabling coverage resets the sink, so a run's map holds only its own
-- hits and never a previous package's.
local function testBeginCoverageResetsTheSink()
	reset()
	_G.__jest_roblox_cov = { ["Foo/bar"] = { 1 } }
	RunnerResult.beginCoverage(JestModule, { coverage = true })

	check(next(_G.__jest_roblox_cov) == nil, "T4: the sink starts empty")
end

-- T5: per-test attribution arms against this run's jest instance and the
-- records its test files collect ride out on the payload.
local function testPerTestCoverageAttaches()
	reset()
	nextInstallation = {
		failure = nil,
		records = { { delta = {}, testCaseId = "adds", testFilePath = "Foo/bar.spec" } },
	}
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(armedWith ~= nil, "T5: the hook is armed")
	check(armedWith.getCoverage() == _G.__jest_roblox_cov, "T5: the hook reads the sink")
	check(armedWith.runtimeClass ~= nil, "T5: the runtime class to patch is handed over")
	check(
		payload.runner.perTestCoverage == nextInstallation.records,
		"T5: the records are attached"
	)
end

-- T5b: the hook is armed against `circus/state`, not the JestCircus package
-- root. Regression: the root re-exports `circus/init`, whose exports carry no
-- `addEventHandler`, so arming there registers nothing and throws mid-run.
local function testPerTestCoverageResolvesCircusState()
	reset()
	RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })

	check(armedWith ~= nil, "T5b: the hook is armed")
	check(armedWith.circusState == CircusStateModule, "T5b: circus/state is the target module")
	check(
		require(CircusModule).addEventHandler == nil,
		"T5b: the fixture mirrors the package root, which has no addEventHandler"
	)
	check(
		typeof(require(armedWith.circusState).addEventHandler) == "function",
		"T5b: the resolved module is the one that has it"
	)
end

-- T6: no per-test flag means no hook, and a run that recorded nothing leaves
-- the field absent rather than encoding an empty list.
local function testPerTestCoverageAbsentCases()
	reset()
	RunnerResult.beginCoverage(JestModule, { coverage = true })
	check(armedWith == nil, "T6: coverage alone does not arm the hook")
	check(disarms == 1, "T6: a run without attribution disarms the standing patch")

	reset()
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(armedWith ~= nil, "T6: the hook is armed")
	check(payload.runner.perTestCoverage == nil, "T6: no records means no field")
end

-- T7: a jest whose circus/expect/runtime packages cannot be resolved fails the
-- run. Attribution that quietly produces nothing reads downstream as "no test
-- covered anything", which is a green, wrong answer.
local function testUnresolvableJestFailsTheRun()
	reset()
	siblingsResolve = false
	local ok = pcall(RunnerResult.beginCoverage, JestModule, { coverage = true, perTest = true })

	check(not ok, "T7: unresolvable attribution fails the run")
end

-- T7b: an install that failed inside a test file's registry surfaces when the
-- run assembles its envelope, rather than reporting partial attribution.
local function testFailedInstallFailsTheRun()
	reset()
	nextInstallation = { failure = "attempt to call a nil value", records = {} }
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })
	local ok, err = pcall(RunnerResult.build, JEST_RESULT, { coverage = state })

	check(not ok, "T7b: a failed install fails the run")
	check(
		string.find(tostring(err), "attempt to call a nil value") ~= nil,
		"T7b: the cause travels with the failure"
	)
end

-- T7c: a sink arms the heartbeat against the same circus/state the coverage
-- hook resolves, so a wedged run publishes which test it reached.
local function testProgressArmsWithASink()
	reset()
	RunnerResult.beginProgress(JestModule, function() end)

	check(progressArms == 1, "T7c: the heartbeat is armed")
	check(progressArmedWith.circusState == CircusStateModule, "T7c: against circus/state")
	check(typeof(progressArmedWith.publish) == "function", "T7c: with the run's sink")
end

-- T7d: no sink means no heartbeat, and the standing patch is stopped either
-- way — it outlives the run that armed it, so a run that publishes nothing has
-- to say so or it keeps writing into the last run's map.
local function testProgressWithoutASinkDisarms()
	reset()
	RunnerResult.beginProgress(JestModule, function() end)
	local armedBefore = progressDisarms
	RunnerResult.beginProgress(JestModule, nil)

	check(progressArms == 1, "T7d: the second run does not arm")
	check(progressDisarms == armedBefore + 1, "T7d: and stops the first")
end

-- T7e: a jest layout the heartbeat cannot hook into costs the run its wedge
-- report and nothing else. Unlike attribution, nothing downstream reads a
-- heartbeat back, so failing the run over one would trade a real result for a
-- diagnostic.
local function testProgressFailureDoesNotFailTheRun()
	reset()
	siblingsResolve = false
	local ok = pcall(RunnerResult.beginProgress, JestModule, function() end)

	check(ok, "T7e: an unhookable jest does not fail the run")
	check(progressArms == 0, "T7e: and nothing is armed")
end

-- T8: setup time is reported only when the patch actually measured some.
local function testSetupSeconds()
	reset()
	local timed = RunnerResult.build(JEST_RESULT, { setupSeconds = 0.25 })
	local untimed = RunnerResult.build(JEST_RESULT, { setupSeconds = 0 })

	check(timed.runner.setup == 0.25, "T8: measured setup time is reported")
	check(untimed.runner == nil, "T8: zero setup time is not reported")
end

-- T9: snapshot writes ride out only when the run wrote one.
local function testSnapshotWrites()
	reset()
	local writes = { ["Foo/__snapshots__/bar.snap"] = "exports[[a]] = [[b]]" }
	local wrote = RunnerResult.build(JEST_RESULT, { snapshotWrites = writes })
	local wroteNothing = RunnerResult.build(JEST_RESULT, { snapshotWrites = {} })

	check(wrote.runner.snapshotWrites == writes, "T9: the writes are attached")
	check(wroteNothing.runner == nil, "T9: an empty write set is not attached")
end

-- T10: timing passes through as the phase builder handed it over, including
-- the nil the builder returns when timing is off.
local function testTiming()
	reset()
	local phases = { jestRunCLI = 1.5, total = 2 }
	local timed = RunnerResult.build(JEST_RESULT, { timing = phases })
	local untimed = RunnerResult.build(JEST_RESULT, { timing = nil })

	check(timed.runner.timing == phases, "T10: the phase table is attached as given")
	check(untimed.runner == nil, "T10: no timing means no runner key")
end

-- T11: the failure half of the seam. A run that produced no result assembles
-- here too, so the envelope a runner emits when it fails is the one this module
-- decides rather than one hand-rolled at each throw site.
local function testFailureEnvelope()
	reset()
	local payload = RunnerResult.fail("boom")

	check(payload.success == false, "T11: the payload reports failure")
	check(payload.err == "boom", "T11: the cause travels as given")
	check(payload.value == nil, "T11: a failure carries no result")
	check(payload.runner == nil, "T11: no dimensions means no runner key")
end

-- T12: why a run was abandoned rides in the same `runner` block every other
-- dimension does, so the host reads it where it reads the rest instead of from
-- a field of its own on the entry.
local function testAbandonReason()
	reset()
	local payload = RunnerResult.fail("Timed out after 5s, aborting tests", {
		abandon = "timeout",
	})

	check(payload.success == false, "T12: an abandoned run is a failure")
	check(payload.runner ~= nil, "T12: the abandon reason populates the runner key")
	check(payload.runner.abandon == "timeout", "T12: and it names the budget")
	check(payload.err ~= nil, "T12: the abandon message travels as the cause")
end

-- T13: a failure with dimensions the run did not produce stays as bare as one
-- with none. An empty `runner` block encodes as `[]`, which reads on the host
-- as a populated-but-empty answer rather than as no answer at all.
local function testFailureWithoutAbandon()
	reset()
	local payload = RunnerResult.fail("boom", {})

	check(payload.runner == nil, "T13: an empty dimension set attaches nothing")
end

-- T14: how far a run got and whether its output was being watched ride in that
-- same block, so a failure that produced nothing else still says both.
local function testPhaseAndCaptureState()
	reset()
	local payload = RunnerResult.fail("Exited with code: 1", {
		captureInstalled = false,
		phase = "run",
	})

	check(payload.runner.phase == "run", "T14: the phase reaches the wire")
	check(payload.runner.captureInstalled == false, "T14: so does a tap that never went on")
	check(payload.runner.abandon == nil, "T14: a run nothing abandoned names no reason")
end

-- T15: and each rides on its own, so a runner reporting one of them does not
-- have to invent the others.
local function testEachDimensionRidesAlone()
	reset()
	local phaseOnly = RunnerResult.fail("boom", { phase = "staging" })
	local captureOnly = RunnerResult.fail("boom", { captureInstalled = true })

	check(phaseOnly.runner.captureInstalled == nil, "T15: a phase alone answers nothing else")
	check(captureOnly.runner.phase == nil, "T15: a capture state alone names no phase")
end

testBareRunHasNoRunnerKey()
testCoverageAttachesTheSink()
testCoverageOffAttachesNothing()
testBeginCoverageResetsTheSink()
testPerTestCoverageAttaches()
testPerTestCoverageResolvesCircusState()
testPerTestCoverageAbsentCases()
testUnresolvableJestFailsTheRun()
testFailedInstallFailsTheRun()
testProgressArmsWithASink()
testProgressWithoutASinkDisarms()
testProgressFailureDoesNotFailTheRun()
testSetupSeconds()
testSnapshotWrites()
testTiming()
testFailureEnvelope()
testAbandonReason()
testFailureWithoutAbandon()
testPhaseAndCaptureState()
testEachDimensionRidesAlone()

print("ALL OK")
