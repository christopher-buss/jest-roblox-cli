--!nocheck
local Envelope = __MODULE__

local function checkEqual(actual: any, expected: any, message: string)
	if actual ~= expected then
		error(message .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual), 0)
	end
end

local failure = Envelope.failure("boom")
checkEqual(failure.success, false, "a failure reports no success")
checkEqual(failure.err, "boom", "a failure carries its error")

local entries = {}
local plain = Envelope.task(entries)
checkEqual(plain.entries, entries, "a task carries its entries")
checkEqual(plain.bailed, nil, "a plain task sets no bail flag")
checkEqual(plain.gameOutputScope, nil, "a plain task sets no scope")

local stopped = Envelope.task(entries, { bailed = true, deferred = false })
checkEqual(stopped.bailed, true, "a bailed task says so")
checkEqual(stopped.deferred, nil, "a false flag stays off the wire")

local batch = Envelope.task(entries, { batch = true })
checkEqual(batch.gameOutputScope, "batch", "a batch capture names its scope")

print("ALL OK")
