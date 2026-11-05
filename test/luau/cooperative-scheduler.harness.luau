--!nocheck
local CircusHook = __HOOK__
local function require(name)
	assert(name == "./circus-hook", "unexpected dependency")
	return CircusHook
end
local Scheduler = __MODULE__
local STATE = {}
local Runtime = {}
function Runtime.setGlobalsForRuntime() end
local function openFile()
	local handlers = {}
	local state = {
		addEventHandler = function(handler)
			table.insert(handlers, handler)
		end,
	}
	local runtime = {
		requireInternalModule = function(_, target)
			assert(target == STATE)
			return state
		end,
	}
	Runtime.setGlobalsForRuntime(runtime, {})
	Runtime.setGlobalsForRuntime(runtime, {})
	return function(name)
		for _, handler in handlers do
			handler(nil, { name = name })
		end
	end,
		handlers
end

local now = 0
local yields = 0
local resumedAt = 0
local phase = "finished"
local observed = false
local function waitForHeartbeat()
	assert(phase == "finished", "yielded before test and afterEach completed")
	assert(observed, "yielded before the completed-test observer")
	yields += 1
	now += 5 -- Scheduling time must not consume the next CPU slice.
	resumedAt = now
end
local function arm()
	return Scheduler.arm({
		circusState = STATE,
		runtimeClass = Runtime,
		now = function()
			return now
		end,
		yield = waitForHeartbeat,
		cancel = coroutine.close,
	})
end
local stop = arm()
local observer = {}
CircusHook.arm({
	circusState = STATE,
	runtimeClass = Runtime,
	report = observer,
	install = function(add)
		add(function(_, event)
			if event.name == "test_done" then
				observed = true
			end
		end)
	end,
})
local dispatch, handlers = openFile()
assert(#handlers == 2, "one handler per consumer per file")
now = 0.099
dispatch("test_done")
assert(yields == 0, "yielded before the time slice elapsed")
now = 0.1
phase = "running"
for _, name in { "test_start", "test_fn_success", "hook_success", "run_describe_finish", "setup" } do
	dispatch(name)
end
assert(yields == 0, "yielded at an unsafe boundary")
phase = "finished"
observed = false
dispatch("test_done")
assert(yields == 1, "exact threshold did not yield")
dispatch("test_done")
assert(yields == 1, "resumption time consumed the next slice")

for _, boundary in { "run_finish", "test_skip", "test_todo" } do
	now = resumedAt + 0.2
	local before = yields
	dispatch(boundary)
	assert(yields == before + 1, "async completion boundary did not yield: " .. boundary)
end

-- A deterministic engine budget: a long synchronous sequence may run many
-- cases, but no resumption may accumulate more than one scheduling slice.
for file = 1, 3 do
	local emit = openFile()
	for _ = 1, 1000 do
		phase = "running"
		now += 0.025
		assert(now - resumedAt < 0.15, "synchronous test chain exhausted the engine budget")
		phase = "finished"
		observed = false
		emit("test_done")
	end
end
assert(yields > 100, "long synchronous suite never released the scheduler")
assert(stop() == nil)
assert(stop() == nil, "stopping a completed run is not idempotent")
local beforeStop = yields
now += 1
dispatch("test_done")
local newDispatch, newHandlers = openFile()
newDispatch("test_done")
assert(yields == beforeStop, "stopped run yielded from an old or new file")
assert(#newHandlers == 1, "stopped consumer remained installed")
CircusHook.disarm(observer)

-- A new run starts a fresh slice rather than inheriting elapsed idle time.
local stopNext = arm()
local nextDispatch = openFile()
nextDispatch("test_done")
assert(yields == beforeStop, "new run inherited the old scheduling budget")
stopNext()

local clockReads = 0
local stopDuringYield
stopDuringYield = Scheduler.arm({
	circusState = STATE,
	runtimeClass = Runtime,
	now = function()
		clockReads += 1
		return now
	end,
	yield = function()
		stopDuringYield()
	end,
	cancel = function()
		error("stop must not cancel its own coroutine")
	end,
})
local canceledDispatch = openFile()
now += 1
canceledDispatch("test_done")
assert(clockReads == 2, "canceled yield resumption continued reading or writing run state")
canceledDispatch("test_done")
assert(clockReads == 2, "stopped handler read the clock again")

-- Promise:expect does not make its caller own the awaited executor. A stopped
-- run must close every parked dispatch before it can launch another test.
local cancellations = 0
local stopParked = Scheduler.arm({
	circusState = STATE,
	runtimeClass = Runtime,
	now = function()
		return now
	end,
	yield = coroutine.yield,
	cancel = function(thread)
		cancellations += 1
		assert(coroutine.status(thread) == "suspended")
		coroutine.close(thread)
	end,
})
local parkedDispatch = openFile()
now += 1
local continued = 0
local function park()
	local thread = coroutine.create(function()
		parkedDispatch("test_done")
		continued += 1
	end)
	assert(coroutine.resume(thread))
	assert(coroutine.status(thread) == "suspended")
	return thread
end
local firstParked = park()
local secondParked = park()
local alreadyClosed = park()
coroutine.close(alreadyClosed)
assert(stopParked() == nil)
assert(stopParked() == nil)
assert(cancellations == 2, "stop did not cancel each live parked dispatch exactly once")
assert(not coroutine.resume(firstParked), "first dispatch continued after stop")
assert(not coroutine.resume(secondParked), "second dispatch continued after stop")
assert(continued == 0, "a stopped dispatch could launch the next test")

-- Once a yield resumes, its coroutine belongs to Jest again.
local stopResumed = Scheduler.arm({
	circusState = STATE,
	runtimeClass = Runtime,
	now = function()
		return now
	end,
	yield = coroutine.yield,
	cancel = function()
		error("stop retained a dispatch that already resumed")
	end,
})
local resumedDispatch = openFile()
now += 1
local resumedThread = coroutine.create(function()
	resumedDispatch("test_done")
	coroutine.yield()
end)
assert(coroutine.resume(resumedThread))
assert(coroutine.resume(resumedThread))
stopResumed()
assert(coroutine.resume(resumedThread))

-- Installation failures remain observable without breaking an unrelated run.
local brokenRuntime = {}
function brokenRuntime.setGlobalsForRuntime() end
local stopBroken = Scheduler.arm({
	circusState = STATE,
	runtimeClass = brokenRuntime,
	now = function()
		return now
	end,
	yield = waitForHeartbeat,
	cancel = coroutine.close,
})
brokenRuntime.setGlobalsForRuntime({
	requireInternalModule = function()
		return {}
	end,
}, {})
assert(string.find(stopBroken(), "exposes no addEventHandler", 1, true))
assert(stopBroken() == nil, "installation failure was reported twice")
print("ALL OK")
