--!nocheck
local ReconnectLoop = __MODULE__

local function fail(message: string)
	error(message, 0)
end

local function checkEqual(actual: any, expected: any, message: string)
	if actual ~= expected then
		fail(message .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual))
	end
end

local function makeScheduler()
	local pending: { { delay: number, callback: () -> (), cancelled: boolean } } = {}

	local scheduler = {}

	function scheduler.delay(seconds: number, callback: () -> ()): any
		local entry = { delay = seconds, callback = callback, cancelled = false }
		table.insert(pending, entry)
		return entry
	end

	function scheduler.cancel(entry: any)
		entry.cancelled = true
	end

	function scheduler.live(): { any }
		local live = {}
		for _, entry in pending do
			if not entry.cancelled then
				table.insert(live, entry)
			end
		end
		return live
	end

	function scheduler.fire()
		local live = scheduler.live()
		checkEqual(#live, 1, "pending attempts before fire")
		local entry = live[1]
		table.remove(pending, table.find(pending, entry))
		entry.callback()
	end

	return scheduler
end

local function makeLoop()
	local scheduler = makeScheduler()
	local attempts: { any } = {}
	local loop = ReconnectLoop.new({
		initialDelay = 0.1,
		maxDelay = 5,
		delay = scheduler.delay,
		cancel = scheduler.cancel,
		connect = function(attempt)
			table.insert(attempts, attempt)
		end,
	})

	return loop, scheduler, attempts
end

local function testBackoffGrowsToCap()
	local loop, scheduler, attempts = makeLoop()
	loop:start()
	checkEqual(#attempts, 1, "start connects at once")

	local expected = { 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 5, 5 }
	for index, delay in expected do
		attempts[#attempts].failed()
		local live = scheduler.live()
		checkEqual(#live, 1, "pending attempts after failure " .. index)
		checkEqual(live[1].delay, delay, "delay after failure " .. index)
		scheduler.fire()
		checkEqual(#attempts, index + 1, "attempts after fire " .. index)
	end
end

local function testOneAttemptFailingTwiceSchedulesOnce()
	local loop, scheduler, attempts = makeLoop()
	loop:start()

	attempts[1].failed()
	attempts[1].failed()
	checkEqual(#scheduler.live(), 1, "pending attempts after error then closed")

	scheduler.fire()
	attempts[2].failed()
	checkEqual(scheduler.live()[1].delay, 0.2, "delay grows once per attempt")
end

local function testOpenedResetsDelay()
	local loop, scheduler, attempts = makeLoop()
	loop:start()

	attempts[1].failed()
	scheduler.fire()
	attempts[2].failed()
	scheduler.fire()
	attempts[3].opened()
	attempts[3].failed()
	checkEqual(scheduler.live()[1].delay, 0.1, "delay after a socket that opened")
end

local function testStopHaltsAndStartResumes()
	local loop, scheduler, attempts = makeLoop()
	loop:start()

	attempts[1].failed()
	scheduler.fire()
	attempts[2].failed()
	loop:stop()
	checkEqual(#scheduler.live(), 0, "pending attempts after stop")

	attempts[2].failed()
	checkEqual(#scheduler.live(), 0, "pending attempts after a stale failure")

	loop:start()
	checkEqual(#attempts, 3, "start after stop connects at once")
	attempts[2].failed()
	attempts[3].failed()
	checkEqual(#scheduler.live(), 1, "pending attempts after restart failure")
	checkEqual(scheduler.live()[1].delay, 0.1, "delay after restart")
end

testBackoffGrowsToCap()
testOneAttemptFailingTwiceSchedulesOnce()
testOpenedResetsDelay()
testStopHaltsAndStartResumes()

print("ALL OK")
