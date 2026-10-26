--!nocheck
-- Lute-driven test for the per-test coverage attribution diff. The module under
-- test is inlined into the placeholder below by coverage-attribution.spec.ts
-- (the same wrap mutation-kernel.spec.ts uses). The functions are pure over a
-- hand-built `_G.__jest_roblox_cov`-shaped hit table — no Roblox, no jest. Any
-- failed assertion calls error(), so a non-zero lute exit fails the wrapper spec.

local attribution = __MODULE__

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

local function count(list: { number }): number
	local total = 0
	for _ in list do
		total += 1
	end

	return total
end

-- S1: a statement hit for the first time during a test is attributed to it.
local function testSingleStatement()
	local before = attribution.snapshot({})
	local after = { ["out/a.luau"] = { s = { 1 } } }

	local delta = attribution.diff(before, after)

	check(delta["out/a.luau"] ~= nil, "S1: covering file present in delta")
	check(contains(delta["out/a.luau"].s, 1), "S1: statement 1 attributed")
end

-- S2: only statements whose count rose are attributed; an unhit statement (count
-- still 0) is excluded even when its neighbours were covered.
local function testExcludesUnhitStatements()
	local before = attribution.snapshot({})
	local after = { ["out/a.luau"] = { s = { 1, 0, 2 } } }

	local delta = attribution.diff(before, after)

	check(count(delta["out/a.luau"].s) == 2, "S2: two statements attributed")
	check(contains(delta["out/a.luau"].s, 1), "S2: statement 1 attributed")
	check(contains(delta["out/a.luau"].s, 3), "S2: statement 3 attributed")
	check(not contains(delta["out/a.luau"].s, 2), "S2: unhit statement 2 excluded")
end

-- S3: against a non-zero baseline, a statement is attributed when its count rises
-- further (a later test re-hits it) but not when it holds steady.
local function testCumulativeBaseline()
	local before = attribution.snapshot({ ["out/a.luau"] = { s = { 1, 5 } } })
	local after = { ["out/a.luau"] = { s = { 2, 5 } } }

	local delta = attribution.diff(before, after)

	check(count(delta["out/a.luau"].s) == 1, "S3: one statement attributed")
	check(contains(delta["out/a.luau"].s, 1), "S3: re-hit statement 1 attributed")
	check(not contains(delta["out/a.luau"].s, 2), "S3: steady statement 2 excluded")
end

-- S4: a test that covers nothing new produces an empty delta (the file is omitted
-- entirely, not recorded with an empty statement list).
local function testEmptyDelta()
	local before = attribution.snapshot({ ["out/a.luau"] = { s = { 1 } } })
	local after = { ["out/a.luau"] = { s = { 1 } } }

	local delta = attribution.diff(before, after)

	check(next(delta) == nil, "S4: no file recorded when nothing new is covered")
end

-- S5: the snapshot is an independent copy — mutating the live table after
-- snapshotting must not change the captured baseline, or the diff would alias
-- `after` and attribute nothing.
local function testSnapshotIsolation()
	local live = { ["out/a.luau"] = { s = { 1 } } }
	local before = attribution.snapshot(live)

	live["out/a.luau"].s[1] = 9

	local delta = attribution.diff(before, live)

	check(contains(delta["out/a.luau"].s, 1), "S5: snapshot captured the pre-mutation count")
end

testSingleStatement()
testExcludesUnhitStatements()
testCumulativeBaseline()
testEmptyDelta()
testSnapshotIsolation()

print("ALL OK")
