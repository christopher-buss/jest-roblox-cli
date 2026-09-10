--!nocheck
local declined = __NOT_CLAIMED__
local expired = __START_EXPIRED__
local values = {}
local expirations = {}
local clock = 1000
local calls = 0
local failures = 0
local lostResponse = false
local contender = false
local crossDeadline = false
local owners = 0
local bodies = 0
local waits = {}
local map = {}
function map:UpdateAsync(key, transform, retention)
	calls += 1
	if expirations[key] ~= nil and clock >= expirations[key] then
		values[key] = nil
	end
	if failures > 0 then
		failures -= 1
		error("MemoryStore unavailable")
	end
	local value = transform(values[key])
	if contender then
		contender = false
		values[key] = "other-server"
		value = transform(values[key])
	end
	if crossDeadline then
		crossDeadline = false
		clock = 2000
		value = transform(values[key])
	end
	if value ~= nil then
		values[key] = value
		expirations[key] = clock + retention * 1000
	end
	if lostResponse then
		lostResponse = false
		error("Response lost after commit")
	end
	return value
end
local game = {}
function game:GetService(name)
	if name == "HttpService" then
		return { GenerateGUID = function()
			owners += 1
			return tostring(owners)
		end }
	end
	assert(name == "MemoryStoreService", "Unexpected service")
	return { GetHashMap = function(_, name)
		assert(name == "jest-roblox-execution-v1", "Unexpected claim map")
		return map
	end }
end
local DateTime = { now = function() return { UnixTimestampMillis = clock } end }
local task = { wait = function(seconds) table.insert(waits, seconds) end }
local function guarded(key, ...)
	__GUARDED__
end
game.PlaceVersion = 41
assert(guarded("guarded") == "ROBLOX_RUNNER_PLACE_MISMATCH:41")
assert(calls == 0 and owners == 0, "Wrong versions return before any claim or rebuild")
game.PlaceVersion = 42
values.guarded = "other-server"
assert(guarded("guarded") == declined,
	"A denied claim returns before reading the missing BinaryInput")
calls = 0
local function run(key)
	__CLAIM__
	bodies += 1
	return "EXECUTED"
end

assert(run("first") == "EXECUTED")
assert(calls == 1 and #waits == 0, "Healthy execution has no retry or sleep")
assert(run("first") == declined, "A late original or replacement cannot execute twice")
assert(bodies == 1)
assert(run("independent") == "EXECUTED", "Independent tasks must not contend")

contender = true
assert(run("race") == declined, "A replayed transform cannot retain a stale successful claim")
assert(values.race == "other-server")

lostResponse = true
assert(run("lost-response") == "EXECUTED", "An uncertain commit can be retried by its owner")
assert(run("lost-response") == declined)

failures = 2
local before = calls
waits = {}
assert(run("transient") == "EXECUTED")
assert(calls == before + 3 and #waits == 2)
assert(waits[1] == 0.1 and waits[2] == 0.2)

failures = 3
before = calls
local bodiesBefore = bodies
waits = {}
local ok, message = pcall(run, "unavailable")
assert(not ok and string.find(message, "Could not claim test execution:", 1, true))
assert(calls == before + 3 and #waits == 2 and bodies == bodiesBefore)

clock = 2000
assert(run("expired") == expired, "The exact startup deadline is exclusive")
values.first = nil
assert(run("first") == expired, "An expired retention cannot let an abandoned task run")
clock = 1000
crossDeadline = true
assert(run("expired-during-claim") == expired, "Every transform replay checks the deadline")
assert(bodies == bodiesBefore)

-- The client deadline is far ahead of the Roblox clock. The replacement
-- claims first; its delayed original arrives after the old fixed TTL.
clock = -1000000
assert(run("skewed") == "EXECUTED")
local beforeDelayed = bodies
clock += 300001
assert(run("skewed") == declined, "Clock skew must not let a delayed original execute twice")
assert(bodies == beforeDelayed)
print("ALL OK")
