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

-- Jest-side stand-ins. `installedWith` records what the per-test hook was
-- handed, so the tests can tell an install from a skip.
local JestModule = {}
local CircusModule = {}
local ExpectModule = {}

local siblingsResolve = true
local installedWith: any = nil
local nextRecords: { any } = {}

local stubs = {
	["./instance-resolver"] = {
		findSiblingPackage = function(_module: any, name: string)
			if not siblingsResolve then
				return nil
			end

			return if name == "JestCircus" then CircusModule else ExpectModule
		end,
	},
	["./per-test-coverage"] = {
		install = function(addEventHandler: any, getState: any, getCoverage: any)
			installedWith = {
				addEventHandler = addEventHandler,
				getCoverage = getCoverage,
				getState = getState,
			}
			return nextRecords
		end,
	},
}

local function require(target: any)
	if target == CircusModule then
		return { addEventHandler = function() end }
	end

	if target == ExpectModule then
		return {
			getState = function()
				return {}
			end,
		}
	end

	local stub = stubs[target]
	check(stub ~= nil, "unstubbed require: " .. tostring(target))
	return stub
end

local warnings = 0
local function warn()
	warnings += 1
end

local RunnerResult = __MODULE__

local JEST_RESULT = { numPassedTests = 3, success = true }

local function reset()
	_G.__jest_roblox_cov = nil
	installedWith = nil
	nextRecords = {}
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

-- T5: per-test attribution installs the hook against this run's jest instance
-- and its records ride out on the payload.
local function testPerTestCoverageAttaches()
	reset()
	nextRecords = { { delta = {}, testCaseId = "adds", testFilePath = "Foo/bar.spec" } }
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(installedWith ~= nil, "T5: the hook is installed")
	check(installedWith.getCoverage() == _G.__jest_roblox_cov, "T5: the hook reads the sink")
	check(payload.runner.perTestCoverage == nextRecords, "T5: the records are attached")
end

-- T6: no per-test flag means no hook, and an installed hook that recorded
-- nothing leaves the field absent rather than encoding an empty list.
local function testPerTestCoverageAbsentCases()
	reset()
	RunnerResult.beginCoverage(JestModule, { coverage = true })
	check(installedWith == nil, "T6: coverage alone does not install the hook")

	reset()
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(installedWith ~= nil, "T6: the hook is installed")
	check(payload.runner.perTestCoverage == nil, "T6: no records means no field")
end

-- T7: a jest whose circus/expect packages cannot be resolved degrades to no
-- attribution — a warning, not a failed run.
local function testUnresolvableJestDegrades()
	reset()
	siblingsResolve = false
	local before = warnings
	local state = RunnerResult.beginCoverage(JestModule, { coverage = true, perTest = true })
	local payload = RunnerResult.build(JEST_RESULT, { coverage = state })

	check(state.hits ~= nil, "T7: coverage itself still runs")
	check(warnings == before + 1, "T7: the unavailable attribution is warned about")
	check(payload.runner.coverage ~= nil, "T7: coverage is still reported")
	check(payload.runner.perTestCoverage == nil, "T7: attribution is absent")
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

testBareRunHasNoRunnerKey()
testCoverageAttachesTheSink()
testCoverageOffAttachesNothing()
testBeginCoverageResetsTheSink()
testPerTestCoverageAttaches()
testPerTestCoverageAbsentCases()
testUnresolvableJestDegrades()
testSetupSeconds()
testSnapshotWrites()
testTiming()

print("ALL OK")
