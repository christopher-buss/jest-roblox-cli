--!nocheck
-- Lute-driven test for the workspace return-envelope budget. Pure over sizes —
-- no Roblox, no MemoryStore. The module under test is inlined into the
-- placeholder below by result-budget.spec.ts. Any failed assertion calls
-- error(), failing the wrapper spec.

local Budget = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- T1: a worker always takes the first item. Stopping on an empty result set
-- would leave the queue undrained forever, however small the budget.
local function testFirstItemAlwaysTaken()
	local tracker = Budget.new(1)

	check(not Budget.shouldStop(tracker), "T1: an empty worker never stops")
end

-- T2: a worker keeps taking work while the envelope plus another entry of the
-- largest size seen so far still fits.
local function testKeepsTakingWhileItFits()
	local tracker = Budget.new(1000)
	Budget.add(tracker, 100)

	check(not Budget.shouldStop(tracker), "T2: 100 used, 100 projected, 1000 cap — keep going")
end

-- T3: the projection uses the largest entry seen, not the last one. A worker
-- that measured a big entry must assume the next one can be as big.
local function testProjectsFromLargestSeen()
	local tracker = Budget.new(1000)
	Budget.add(tracker, 600)
	Budget.add(tracker, 10)

	check(
		Budget.shouldStop(tracker),
		"T3: 610 used and a 600-byte entry seen must stop against a 1000 cap"
	)
end

-- T4: the budget is what bounds the envelope. 400 used with a 400 worst case
-- fits 1000; one more of the same would not.
local function testStopsBeforeOverflow()
	local tracker = Budget.new(1000)
	Budget.add(tracker, 400)
	check(not Budget.shouldStop(tracker), "T4: 400 + 400 fits under 1000")

	Budget.add(tracker, 400)
	check(Budget.shouldStop(tracker), "T4: 800 + 400 overflows 1000")
end

-- T5: measuring an entry counts the fields that dominate the encoded envelope
-- and stays above the raw payload, so the projection never runs optimistic.
local function testMeasureCountsPayloadFields()
	local measured = Budget.measure({
		bannerOutput = "cd",
		gameOutput = "bcd",
		jestOutput = string.rep("a", 100),
		pkg = "x",
		project = "y",
	})

	check(measured >= 105, "T5: measure counts every payload field, got " .. tostring(measured))
end

-- T6: a nil optional field is not an error and contributes nothing.
local function testMeasureToleratesMissingFields()
	local measured = Budget.measure({ jestOutput = string.rep("a", 50), pkg = "x", project = "y" })

	check(measured >= 50, "T6: measure handles absent optional fields")
end

testFirstItemAlwaysTaken()
testKeepsTakingWhileItFits()
testProjectsFromLargestSeen()
testStopsBeforeOverflow()
testMeasureCountsPayloadFields()
testMeasureToleratesMissingFields()

print("ALL OK")
