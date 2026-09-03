--!nocheck
-- Lute-driven test for the shared infinite-yield watchdog. The module under
-- test is inlined into the placeholder below by infinite-yield.spec.ts, so the
-- fake `game`, `Enum` and `task` declared here are the upvalues it closes over.
-- Any failed assertion calls error(), failing the wrapper spec.

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- Fake LogService.MessageOut. `emit` stands in for the engine reporting a
-- message, which is the only way a warning reaches the watchdog.
local listeners = {}
local MessageOut = {}

function MessageOut:Connect(handler)
	local id = {}
	listeners[id] = handler
	return {
		Disconnect = function()
			listeners[id] = nil
		end,
	}
end

-- The guard connects exactly one handler, so this answers "is the watch on?".
local function isWatching(): boolean
	return next(listeners) ~= nil
end

local OUTPUT = { Value = 0 }
local WARNING = { Value = 2 }

local Enum = { MessageType = { MessageOutput = OUTPUT, MessageWarning = WARNING } }

local function emit(message: string, messageType)
	for _, handler in listeners do
		handler(message, messageType)
	end
end

local LogService = { MessageOut = MessageOut }
local game = {
	GetService = function(_, name: string)
		check(name == "LogService", "unstubbed service: " .. name)
		return LogService
	end,
}

-- Faithful enough `task.spawn`: it resumes immediately, so a thunk that never
-- yields finishes before the call returns, and a parked caller is woken the
-- moment the watchdog says so. `armed` holds the deadlines `task.delay` has
-- taken and the clock has not reached.
local armed = {}

local task = {
	spawn = function(target, ...)
		local thread = if type(target) == "thread" then target else coroutine.create(target)
		local ok, err = coroutine.resume(thread, ...)
		if not ok then
			fail("task.spawn thread errored: " .. tostring(err))
		end

		return thread
	end,
	delay = function(seconds: number, callback)
		local thread = coroutine.create(callback)
		table.insert(armed, { seconds = seconds, thread = thread })
		return thread
	end,
	cancel = function(target)
		for index, entry in armed do
			if entry.thread == target then
				table.remove(armed, index)
				coroutine.close(target)
				return
			end
		end

		-- What the engine does when asked to cancel a thread that already ran.
		-- A watchdog that cancelled a fired deadline would land here.
		fail("task.cancel: thread is not armed")
	end,
}

-- The clock reaching every armed deadline at once. Nothing here advances on
-- its own, so a test says exactly when a budget runs out.
local function elapse()
	local due = armed
	armed = {}
	for _, entry in due do
		local ok, err = coroutine.resume(entry.thread)
		if not ok then
			fail("deadline thread errored: " .. tostring(err))
		end
	end
end

local InfiniteYield = __MODULE__

local YIELD_WARNING = "Infinite yield possible on 'ReplicatedStorage.shared:WaitForChild(\"x\")'"
local ABORT_PREFIX = "Infinite yield detected, aborting tests: "

-- Calls the watchdog from a thread the harness owns, so a run that parks its
-- caller can be resumed here the way the engine's warning resumes it in
-- production. `done` stays false while the caller is parked.
local function guardInThread(fn, options)
	local outcome = { done = false }
	local thread = coroutine.create(function()
		outcome.ok, outcome.value, outcome.timedOut = InfiniteYield.guard(fn, options)
		outcome.done = true
	end)

	local ok, err = coroutine.resume(thread)
	check(ok, "guard thread errored: " .. tostring(err))
	return outcome
end

-- Parks like a `WaitForChild` that has not resolved yet. `parkedThread` is the
-- thunk's own thread, which the abort assertions read back.
local parkedThread: thread? = nil
local function parkForever()
	parkedThread = coroutine.running()
	coroutine.yield()
	fail("the parked thunk was resumed")
end

-- T1: a thunk that returns hands its value back, and leaves no listener behind.
local function testReturnedValueIsPassedThrough()
	local outcome = guardInThread(function()
		return "value"
	end)

	check(outcome.done, "T1: a thunk that returns does not park its caller")
	check(outcome.ok == true, "T1: a thunk that returns reports success")
	check(outcome.value == "value", "T1: the thunk's value is passed through")
	check(not isWatching(), "T1: the watch is disconnected when the run ends")
end

-- T2: a thunk that throws is reported as a failure, not as an abort — the
-- watchdog only replaces the outcome when the warning arrived first.
local function testThrownErrorIsPassedThrough()
	local outcome = guardInThread(function()
		error("jest exploded", 0)
	end)

	check(outcome.ok == false, "T2: a thunk that throws reports failure")
	check(outcome.value == "jest exploded", "T2: the thunk's error is passed through")
	check(not isWatching(), "T2: the watch is disconnected on the error path")
end

-- T3: the production ordering — the thunk parks first, and the warning arrives
-- five seconds later. The caller is woken by the warning rather than by a poll.
local function testWarningWhileParkedAbortsTheRun()
	local outcome = guardInThread(parkForever)

	check(not outcome.done, "T3: a parked thunk parks its caller")
	check(isWatching(), "T3: the watch is still connected while parked")

	emit(YIELD_WARNING, WARNING)

	check(outcome.done, "T3: the warning wakes the parked caller")
	check(outcome.ok == false, "T3: an infinite yield is a failure")
	check(outcome.value == ABORT_PREFIX .. YIELD_WARNING, "T3: the abort names the yield")
	check(not isWatching(), "T3: the watch is disconnected after an abort")
	check(coroutine.status(parkedThread) == "dead", "T3: the abandoned thunk is closed")
end

-- T4: the same verdict when the warning lands before the thunk parks, which is
-- the ordering a thunk that yields for its own reasons after the warn produces.
local function testWarningBeforeParkAbortsTheRun()
	local outcome = guardInThread(function()
		emit(YIELD_WARNING, WARNING)
		parkForever()
	end)

	check(outcome.done, "T4: an early warning never parks the caller")
	check(outcome.ok == false, "T4: an early warning is still a failure")
	check(outcome.value == ABORT_PREFIX .. YIELD_WARNING, "T4: the abort names the yield")
end

-- T5: only the first warning is reported, so the message names the yield that
-- ended the run rather than whichever one arrived last.
local function testFirstWarningWins()
	local outcome = guardInThread(function()
		emit(YIELD_WARNING, WARNING)
		emit("Infinite yield possible on 'Other'", WARNING)
		parkForever()
	end)

	check(outcome.value == ABORT_PREFIX .. YIELD_WARNING, "T5: the first warning is the one named")
end

-- T6: neither an unrelated warning nor the same text at another message type
-- ends a run — an engine warning is the only signal, and print is not one.
local function testUnrelatedMessagesAreIgnored()
	local outcome = guardInThread(function()
		emit("Something else entirely", WARNING)
		emit(YIELD_WARNING, OUTPUT)
		return "value"
	end)

	check(outcome.ok == true, "T6: unrelated messages leave the run alone")
	check(outcome.value == "value", "T6: the thunk's value survives them")
end

-- T7: the warning is a reason to stop waiting, not a verdict of its own. A
-- thunk that reached its end despite one keeps the result it produced.
local function testFinishedRunKeepsItsResult()
	local outcome = guardInThread(function()
		emit(YIELD_WARNING, WARNING)
		return "value"
	end)

	check(outcome.ok == true, "T7: a run that finished reports its own outcome")
	check(outcome.value == "value", "T7: the thunk's value survives the warning")
end

-- T8: a warning between runs belongs to nothing — the watch of the run that
-- ended is disconnected, so the next run cannot inherit it.
local function testWarningBetweenRunsAbortsNothing()
	emit(YIELD_WARNING, WARNING)

	local outcome = guardInThread(function()
		return "second"
	end)

	check(outcome.ok == true, "T8: a warning between runs abandons no later run")
	check(outcome.value == "second", "T8: the later run keeps its own value")
end

-- T9: the abandoned thunk is closed rather than left parked, so a child that
-- turns up later cannot resume it into whatever is running by then.
local function testAbandonedThunkCannotWakeLater()
	local outcome = guardInThread(parkForever)
	check(not outcome.done, "T9: the thunk parks its caller")

	emit(YIELD_WARNING, WARNING)

	-- What the engine does when the awaited instance is finally parented. A
	-- thunk left alive would run on into its own `fail`.
	local resumeOk = coroutine.resume(parkedThread :: any)

	check(not resumeOk, "T9: the closed thunk refuses to resume")
end

-- T10: the caller's cleanup is what reaches the thread the engine parked — the
-- thunk only waits on it — so an abort must run it, and run it before the
-- guard hands its verdict back.
local function testAbandonRunsTheCallersCleanup()
	local cancelled = false
	local outcome = guardInThread(parkForever, {
		onAbandon = function()
			cancelled = true
		end,
	})

	check(not cancelled, "T10: nothing is cancelled while the run is only slow")

	emit(YIELD_WARNING, WARNING)

	check(cancelled, "T10: an abort runs the cleanup")
	check(outcome.ok == false, "T10: the abort is still reported")
end

-- T11: a run that ends on its own cancels nothing, whether it returned or
-- threw — there is no abandoned work to end.
local function testFinishedRunSkipsTheCleanup()
	local cancelled = false
	local returned = guardInThread(function()
		return "value"
	end, {
		onAbandon = function()
			cancelled = true
		end,
	})
	local threw = guardInThread(function()
		error("jest exploded", 0)
	end, {
		onAbandon = function()
			cancelled = true
		end,
	})

	check(returned.ok == true and threw.ok == false, "T11: both runs ended on their own")
	check(not cancelled, "T11: neither run cancels anything")
end

-- T12: cleanup is best-effort. A cancel that throws cannot turn the abort into
-- something else, or the run would report the cleanup's problem instead of the
-- yield that caused it.
local function testThrowingCleanupKeepsTheVerdict()
	local outcome = guardInThread(parkForever, {
		onAbandon = function()
			error("cancel exploded", 0)
		end,
	})

	emit(YIELD_WARNING, WARNING)

	check(outcome.ok == false, "T12: the abort survives a throwing cleanup")
	check(outcome.value == ABORT_PREFIX .. YIELD_WARNING, "T12: it still names the yield")
end

-- T13: the whole point of the budget — a run still parked when it runs out is
-- abandoned the way a warned one is, and says which of the two happened.
local function testElapsedBudgetAbortsTheRun()
	local cancelled = false
	local outcome = guardInThread(parkForever, {
		onAbandon = function()
			cancelled = true
		end,
		timeoutMs = 60_000,
	})

	check(not outcome.done, "T13: a parked thunk parks its caller")
	check(not cancelled, "T13: nothing is cancelled while the run is within budget")

	elapse()

	check(outcome.done, "T13: the elapsed budget wakes the parked caller")
	check(outcome.ok == false, "T13: an elapsed budget is a failure")
	check(outcome.value == "Timed out after 60s, aborting tests", "T13: the abort names the budget")
	check(outcome.timedOut == true, "T13: the abort says it was the budget, not a yield")
	check(cancelled, "T13: an elapsed budget runs the cleanup")
	check(coroutine.status(parkedThread) == "dead", "T13: the abandoned thunk is closed")
	check(not isWatching(), "T13: the watch is disconnected after a timeout")
end

-- T14: a warning that lands first ends the run and disarms the budget, so the
-- deadline cannot fire into a guard that already returned.
local function testWarningDisarmsTheBudget()
	local outcome = guardInThread(parkForever, { timeoutMs = 60_000 })

	check(#armed == 1, "T14: the budget is armed while the run is only slow")

	emit(YIELD_WARNING, WARNING)

	check(outcome.timedOut == false, "T14: the warning is what ended it, not the budget")
	check(#armed == 0, "T14: ending the run disarms the budget")
end

-- T15: zero is how a config asks for no budget at all, and an absent one is the
-- same answer — the warning stays the only thing that can end the run.
local function testNoBudgetArmsNoDeadline()
	local zero = guardInThread(parkForever, { timeoutMs = 0 })
	check(#armed == 0, "T15: a zero budget arms no deadline")
	emit(YIELD_WARNING, WARNING)
	check(zero.ok == false and zero.timedOut == false, "T15: the run still ends on the warning")

	local absent = guardInThread(parkForever, {})
	check(#armed == 0, "T15: an absent budget arms no deadline")
	emit(YIELD_WARNING, WARNING)
	check(absent.ok == false and absent.timedOut == false, "T15: that run ends on the warning too")
end

-- T16: a budget is a deadline, not a verdict. A run that finished inside it
-- keeps its own result and names no abandon reason.
local function testRunWithinBudgetKeepsItsResult()
	local outcome = guardInThread(function()
		return "value"
	end, { timeoutMs = 60_000 })

	check(outcome.ok == true, "T16: a run within budget reports its own outcome")
	check(outcome.value == "value", "T16: the thunk's value is passed through")
	check(outcome.timedOut == false, "T16: a run that finished did not run out of time")
end

-- T17: the budget covers the thunk's first turn. `task.spawn` runs `fn` up to
-- its first yield before it returns, so a deadline armed after that call would
-- exclude every bit of synchronous setup from the budget it advertises — 50s of
-- resolving instances followed by a park would get a further 60s.
local function testBudgetCoversWorkBeforeTheFirstYield()
	local cancelled = false
	local outcome = guardInThread(function()
		-- The clock running out during that first turn, which is the one
		-- stretch of a run that cannot resume the caller: it is not parked yet.
		elapse()
		parkForever()
	end, {
		onAbandon = function()
			cancelled = true
		end,
		timeoutMs = 60_000,
	})

	check(outcome.done, "T17: a budget spent before the first yield never parks the caller")
	check(outcome.ok == false, "T17: it is still a failure")
	check(outcome.timedOut == true, "T17: it is reported as the budget, not a yield")
	check(outcome.value == "Timed out after 60s, aborting tests", "T17: the abort names the budget")
	check(cancelled, "T17: it runs the cleanup like any other abandon")
	check(not isWatching(), "T17: the watch is disconnected")
end

testReturnedValueIsPassedThrough()
testThrownErrorIsPassedThrough()
testWarningWhileParkedAbortsTheRun()
testWarningBeforeParkAbortsTheRun()
testFirstWarningWins()
testUnrelatedMessagesAreIgnored()
testFinishedRunKeepsItsResult()
testWarningBetweenRunsAbortsNothing()
testAbandonedThunkCannotWakeLater()
testAbandonRunsTheCallersCleanup()
testFinishedRunSkipsTheCleanup()
testThrowingCleanupKeepsTheVerdict()
testElapsedBudgetAbortsTheRun()
testWarningDisarmsTheBudget()
testNoBudgetArmsNoDeadline()
testRunWithinBudgetKeepsItsResult()
testBudgetCoversWorkBeforeTheFirstYield()

print("ALL OK")
