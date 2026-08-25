--!nocheck
-- Lute-driven test for the coordinator's dispatch arithmetic: which configs go
-- to which VM host, and how the entries the hosts send back become one
-- request-ordered array. Pure table math over an injected `encode` — no
-- Roblox, no jest. The module under test is inlined into the placeholder below
-- by vm-parallel.spec.ts. Any failed assertion calls error(), failing the
-- wrapper spec.

local VmParallel = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

local function checkList(actual: { number }, expected: { number }, message: string)
	check(#actual == #expected, message .. " (length " .. #actual .. ")")
	for index, value in expected do
		check(actual[index] == value, message .. " (index " .. index .. ")")
	end
end

-- Stands in for `HttpService:JSONEncode`, which the module takes as a
-- dependency so its planning half runs outside Roblox. Renders only the fields
-- the CLI reads back off an ExecutionError entry.
local function encode(value: any): string
	return "kind="
		.. tostring(value.value.kind)
		.. ";error="
		.. tostring(value.value.error)
		.. ";success="
		.. tostring(value.success)
end

local function entry(jestOutput: string): any
	return { bannerOutput = "[]", elapsedMs = 1, jestOutput = jestOutput }
end

-- T1: configs alternate across hosts, so consecutive (and typically
-- similarly-sized) projects do not stack on one VM.
local function testRoundRobinSplit()
	local slices = VmParallel.planSlices({ configCount = 5, hostCount = 2 })

	check(#slices == 2, "T1: one slice per host")
	checkList(slices[1], { 1, 3, 5 }, "T1: host 1 takes the odd configs")
	checkList(slices[2], { 2, 4 }, "T1: host 2 takes the even configs")
end

-- T2: more hosts than configs plans no empty slice — the coordinator
-- dispatches to exactly as many hosts as it can use.
local function testMoreHostsThanConfigs()
	local slices = VmParallel.planSlices({ configCount = 2, hostCount = 4 })

	check(#slices == 2, "T2: only the usable hosts get a slice")
	checkList(slices[1], { 1 }, "T2: first host takes one config")
	checkList(slices[2], { 2 }, "T2: second host takes one config")
end

-- T3: a single host is the sequential slice.
local function testSingleHost()
	local slices = VmParallel.planSlices({ configCount = 3, hostCount = 1 })

	check(#slices == 1, "T3: one slice")
	checkList(slices[1], { 1, 2, 3 }, "T3: the one host takes every config")
end

-- T4: hosts finish in whatever order their projects end; the envelope is in
-- the order the CLI asked for.
local function testRequestOrder()
	local ordered = VmParallel.finalizeEntries({
		configCount = 3,
		encode = encode,
		received = { [3] = entry("third"), [1] = entry("first"), [2] = entry("second") },
	})

	check(#ordered == 3, "T4: one entry per config")
	check(ordered[1].jestOutput == "first", "T4: first config first")
	check(ordered[2].jestOutput == "second", "T4: second config second")
	check(ordered[3].jestOutput == "third", "T4: third config third")
end

-- T5: a host that died leaves its configs unanswered. Each gap becomes an
-- ExecutionError entry, so the envelope stays parallel to the configs and the
-- hosts that did answer still report.
local function testMissingEntriesBecomeExecutionErrors()
	local ordered = VmParallel.finalizeEntries({
		configCount = 2,
		encode = encode,
		missingError = "host 1 stopped answering",
		received = { [2] = entry("second") },
	})

	check(
		ordered[1].jestOutput == "kind=ExecutionError;error=host 1 stopped answering;success=true",
		"T5: the gap carries the reason"
	)
	check(ordered[1].bannerOutput == "[]", "T5: the gap has no banner output")
	check(ordered[1].elapsedMs == 0, "T5: the gap took no measurable time")
	check(ordered[2].jestOutput == "second", "T5: the answered config is untouched")
end

-- T6: an unanswered config with no stated reason still says what happened.
local function testMissingEntryDefaultReason()
	local ordered = VmParallel.finalizeEntries({ configCount = 1, encode = encode, received = {} })

	check(
		string.find(ordered[1].jestOutput, "returned no result", 1, true) ~= nil,
		"T6: the default reason names the missing result"
	)
end

-- T12: the coordinator's wait has to end before the CLI stops listening, or
-- the partial ExecutionError entries it exists to deliver never reach anyone.
-- It takes a share of the run budget the CLI sent, leaving the rest for Studio
-- to boot and for the result to travel back.
local function testHostDeadlineFitsTheRunBudget()
	local seconds = VmParallel.resolveHostDeadlineSeconds(300000)

	check(seconds < 300, "T12: the host deadline lands inside the run budget")
	check(seconds >= 200, "T12: it still spends most of the budget running tests")
end

-- T13: a budget so small that its share would be unusable still waits long
-- enough for a run to finish and report.
local function testHostDeadlineFloorsAtAUsableWait()
	local seconds = VmParallel.resolveHostDeadlineSeconds(1000)

	check(seconds >= 30, "T13: a tiny budget still gets a usable wait")
end

-- T14: no budget in the payload falls back to the CLI's own default rather
-- than waiting indefinitely.
local function testHostDeadlineWithoutABudget()
	local seconds = VmParallel.resolveHostDeadlineSeconds(nil)

	check(seconds == VmParallel.resolveHostDeadlineSeconds(300000), "T14: default budget is 300s")
end

-- T8: two configs whose stub mounts nest must run on one host. Their
-- `jest.config` stubs would otherwise sit in the DataModel at the same time,
-- and Jest's parent-traversal config lookup resolves the wrong one — the
-- hazard the coordinator's just-in-time injection exists to avoid. On one host
-- they run sequentially, injected and cleaned up one at a time.
local function testNestedMountsShareAHost()
	local slices = VmParallel.planSlices({
		configCount = 2,
		hostCount = 2,
		mounts = { { "ReplicatedStorage" }, { "ReplicatedStorage/Foo" } },
	})

	check(#slices == 1, "T8: the nesting pair collapses to one slice")
	checkList(slices[1], { 1, 2 }, "T8: both configs land on the same host")
end

-- T9: the same mount twice is the same collision (one leaf, one `jest.config`).
local function testIdenticalMountsShareAHost()
	local slices = VmParallel.planSlices({
		configCount = 2,
		hostCount = 2,
		mounts = { { "ServerScriptService/Pkg" }, { "ServerScriptService/Pkg" } },
	})

	check(#slices == 1, "T9: identical mounts collapse to one slice")
	checkList(slices[1], { 1, 2 }, "T9: both configs land on the same host")
end

-- T10: nesting is by path segment, not by string prefix — `Foo` does not
-- contain `Foobar`, so those two projects still overlap across hosts.
local function testSiblingMountsDoNotShareAHost()
	local slices = VmParallel.planSlices({
		configCount = 2,
		hostCount = 2,
		mounts = { { "ReplicatedStorage/Foo" }, { "ReplicatedStorage/Foobar" } },
	})

	check(#slices == 2, "T10: sibling mounts still split across hosts")
	checkList(slices[1], { 1 }, "T10: first host takes the first config")
	checkList(slices[2], { 2 }, "T10: second host takes the second config")
end

-- T11: grouping must not strand a host. Two of three configs nest, so the
-- third still gets a host of its own and the run keeps two VMs busy.
local function testGroupingLeavesNoHostIdle()
	local slices = VmParallel.planSlices({
		configCount = 3,
		hostCount = 2,
		mounts = {
			{ "ReplicatedStorage" },
			{ "ServerScriptService/Pkg" },
			{ "ReplicatedStorage/Foo" },
		},
	})

	check(#slices == 2, "T11: both hosts get work")
	checkList(slices[1], { 1, 3 }, "T11: the nesting pair shares a host")
	checkList(slices[2], { 2 }, "T11: the independent config runs alongside")
end

-- T7: the shape the CLI parses for a project that could not run at all,
-- matching what `Runner.runProjects` already emits for a config that threw.
local function testExecutionErrorEntry()
	local built = VmParallel.executionErrorEntry({ encode = encode, message = "host threw" })

	check(
		built.jestOutput == "kind=ExecutionError;error=host threw;success=true",
		"T7: the message travels inside an ExecutionError result"
	)
	check(built.gameOutput == nil, "T7: no per-project game output under parallel")
end

testNestedMountsShareAHost()
testIdenticalMountsShareAHost()
testSiblingMountsDoNotShareAHost()
testGroupingLeavesNoHostIdle()
testRoundRobinSplit()
testMoreHostsThanConfigs()
testSingleHost()
testRequestOrder()
testMissingEntriesBecomeExecutionErrors()
testMissingEntryDefaultReason()
testExecutionErrorEntry()
testHostDeadlineFitsTheRunBudget()
testHostDeadlineFloorsAtAUsableWait()
testHostDeadlineWithoutABudget()

print("ALL OK")
