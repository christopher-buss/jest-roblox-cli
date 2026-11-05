--!nocheck
-- Lute-driven test for the workspace bail signal. Pure over a fake SortedMap —
-- no Roblox, no MemoryStore. The module under test is inlined into the
-- placeholder below by bail.spec.ts. Any failed assertion calls error(),
-- failing the wrapper spec.

local Bail = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- Stands in for `MemoryStoreService:GetSortedMap(id)`. Records every call so a
-- test can assert what crossed the wire, and can be told to throw the way a
-- throttled or unscoped API call does.
local function newMap(options: { stored: any?, throwOnGet: boolean?, throwOnSet: boolean? }?)
	local settings = options or {}
	local map = {
		getCalls = 0,
		setCalls = {},
		stored = settings.stored,
	}

	function map:GetAsync(key: string)
		self.getCalls += 1
		if settings.throwOnGet then
			error("GetAsync failed")
		end

		return if key == Bail.SIGNAL_KEY then self.stored else nil
	end

	function map:SetAsync(key: string, value: any, ttl: number)
		if settings.throwOnSet then
			error("SetAsync failed")
		end

		table.insert(self.setCalls, { key = key, ttl = ttl, value = value })
		return true
	end

	return map
end

-- B1: without --bail a failing package changes nothing; the walk runs on.
local function testDisabledNeverStops()
	local state = Bail.new({ enabled = false, ttlSeconds = 600 })
	Bail.observe(state, false)

	check(not Bail.shouldStop(state), "B1: bail disabled must not stop on a failure")
end

-- B2: a passing package leaves an enabled bail untripped.
local function testPassingPackageDoesNotTrip()
	local state = Bail.new({ enabled = true, ttlSeconds = 600 })
	Bail.observe(state, true)

	check(not Bail.shouldStop(state), "B2: a passing package must not trip bail")
end

-- B3: the first failing package stops the walk.
local function testFailingPackageTrips()
	local state = Bail.new({ enabled = true, ttlSeconds = 600 })
	Bail.observe(state, false)

	check(Bail.shouldStop(state), "B3: a failing package must trip bail")
end

-- B4: the trip is broadcast so sibling tasks sharing the map see it. Written
-- under the reserved key with the run's TTL, never under a package key.
local function testTripBroadcastsSignal()
	local map = newMap()
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 300 })
	Bail.observe(state, false)

	check(#map.setCalls == 1, "B4: a trip writes exactly one signal")
	local write = map.setCalls[1]
	check(write.key == Bail.SIGNAL_KEY, "B4: the signal uses the reserved key")
	check(write.ttl == 300, "B4: the signal carries the run TTL")
end

-- B5: a passing package writes nothing — otherwise the first package to
-- finish would halt every sibling.
local function testPassDoesNotBroadcast()
	local map = newMap()
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 600 })
	Bail.observe(state, true)

	check(#map.setCalls == 0, "B5: a passing package broadcasts nothing")
end

-- B6: a sibling's signal stops this task even though it saw no failure of its
-- own. This is the parallel-mode fail-fast path.
local function testSiblingSignalStops()
	local map = newMap({ stored = { bailed = true } })
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 600 })

	check(Bail.shouldStop(state), "B6: a sibling's signal must stop this task")
end

-- B7: an empty map means nobody has failed; the task keeps popping.
local function testEmptyMapKeepsGoing()
	local map = newMap()
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 600 })

	check(not Bail.shouldStop(state), "B7: an unsignalled map must not stop the task")
end

-- B8: bail disabled never reads the map at all — no per-pop API call is spent
-- on a run that did not ask to fail fast.
local function testDisabledNeverReadsMap()
	local map = newMap({ stored = { bailed = true } })
	local state = Bail.new({ enabled = false, map = map, ttlSeconds = 600 })

	check(not Bail.shouldStop(state), "B8: bail disabled ignores a stale signal")
	check(map.getCalls == 0, "B8: bail disabled spends no read")
end

-- B9: once tripped the answer is settled, so the map is not read again on
-- every subsequent check.
local function testTrippedStopsReading()
	local map = newMap()
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 600 })
	Bail.observe(state, false)

	check(Bail.shouldStop(state), "B9: a tripped state stops")
	check(map.getCalls == 0, "B9: a tripped state reads no further")
end

-- B10: a read that throws (throttled, unscoped key) reads as "no signal". The
-- run degrades to per-task bail rather than dying inside the pop loop.
local function testReadFailureIsNotFatal()
	local map = newMap({ throwOnGet = true })
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 600 })

	check(not Bail.shouldStop(state), "B10: a failed read must not stop the task")
end

-- B12: the enabled flag is readable, so callers can skip work only the bail
-- decision needs — decoding a package's Jest output to learn whether it passed.
local function testIsEnabledReportsTheFlag()
	check(
		Bail.isEnabled(Bail.new({ enabled = true, ttlSeconds = 600 })),
		"B12: --bail reads as enabled"
	)
	check(
		not Bail.isEnabled(Bail.new({ enabled = false, ttlSeconds = 600 })),
		"B12: no --bail reads as disabled"
	)
	check(
		not Bail.isEnabled(Bail.new({ ttlSeconds = 600 })),
		"B12: an absent flag reads as disabled"
	)
end

-- B11: a write that throws still trips this task locally — the broadcast is
-- best effort, the local decision is not.
local function testWriteFailureStillTripsLocally()
	local map = newMap({ throwOnSet = true })
	local state = Bail.new({ enabled = true, map = map, ttlSeconds = 600 })
	Bail.observe(state, false)

	check(Bail.shouldStop(state), "B11: a failed broadcast still trips locally")
end

testDisabledNeverStops()
testPassingPackageDoesNotTrip()
testFailingPackageTrips()
testTripBroadcastsSignal()
testPassDoesNotBroadcast()
testSiblingSignalStops()
testEmptyMapKeepsGoing()
testDisabledNeverReadsMap()
testTrippedStopsReading()
testReadFailureIsNotFatal()
testWriteFailureStillTripsLocally()
testIsEnabledReportsTheFlag()

print("ALL OK")
