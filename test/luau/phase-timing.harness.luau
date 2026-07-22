--!nocheck
-- Lute-driven test for the shared `_timing` envelope builder. Pure over a list
-- of already-measured (name, seconds) pairs — no Roblox, no jest, no os.clock
-- dependency of its own. The module under test is inlined into the
-- placeholder below by phase-timing.spec.ts. Any failed assertion calls
-- error(), failing the wrapper spec.

local PhaseTiming = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

local function count(t: { [string]: number }): number
	local total = 0
	for _ in t do
		total += 1
	end

	return total
end

-- T1: disabled returns nil regardless of the phases given.
local function testDisabledReturnsNil()
	local result = PhaseTiming.build(false, { { name = "findJest", seconds = 0.1 } })

	check(result == nil, "T1: disabled build returns nil")
end

-- T2: nil enabled (the config field being absent) behaves the same as false.
local function testNilEnabledReturnsNil()
	local result = PhaseTiming.build(nil, { { name = "findJest", seconds = 0.1 } })

	check(result == nil, "T2: nil-enabled build returns nil")
end

-- T3: enabled maps every phase's name to its seconds, unrounded and
-- unconverted — the host converts seconds to ms, not this module.
local function testEnabledMapsPhases()
	local result = PhaseTiming.build(true, {
		{ name = "findJest", seconds = 0.1 },
		{ name = "jestRunCLI", seconds = 2.5 },
	})

	check(result ~= nil, "T3: enabled build returns a table")
	check(result.findJest == 0.1, "T3: findJest seconds passed through")
	check(result.jestRunCLI == 2.5, "T3: jestRunCLI seconds passed through")
	check(count(result) == 2, "T3: no extra keys added")
end

-- T4: enabled with no phases returns an empty table, not nil — the caller
-- can still tell "timing was on" from a defined (if empty) result.
local function testEnabledEmptyPhases()
	local result = PhaseTiming.build(true, {})

	check(result ~= nil, "T4: enabled build with no phases is still a table")
	check(count(result) == 0, "T4: empty phases produce an empty table")
end

testDisabledReturnsNil()
testNilEnabledReturnsNil()
testEnabledMapsPhases()
testEnabledEmptyPhases()

print("ALL OK")
