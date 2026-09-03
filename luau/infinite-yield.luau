--!strict
-- Watchdog for a Jest run neither Jest nor the engine will end, shared by both
-- dispatch modes: `runner.luau` for a multi run and
-- `staging/embedded-runner.luau` for a workspace one. Two things end such a run
-- here — an infinite-yield warning, and the project's own wall-clock budget.
--
-- `WaitForChild` without a timeout warns "Infinite yield possible" after five
-- seconds and then yields forever — the engine never abandons it. A test file
-- that imports a module missing from the DataModel parks Jest there, and
-- nothing else in the run can end it: the per-test timeout has no thread to
-- interrupt, and the module never reached a test to begin with. Left alone the
-- task burns its whole deadline and Roblox reports DEADLINE_EXCEEDED, which
-- names neither the test nor the instance.

local LogService = game:GetService("LogService")

local WARNING_NEEDLE = "Infinite yield possible"
local ABORT_PREFIX = "Infinite yield detected, aborting tests: "
-- The whole of what the report says about an abandoned run, so it names the
-- budget rather than the machinery: the reader raises a number, not a watchdog.
local TIMEOUT_FORMAT = "Timed out after %gs, aborting tests"
-- Hoisted: the handler runs on every line the run logs.
local MESSAGE_WARNING = Enum.MessageType.MessageWarning

local module = {}

export type Options = {
	onAbandon: (() -> ())?,
	-- Wall-clock budget for `fn`, in the milliseconds the host config and the
	-- argv both speak. Absent (or zero) means the warning is the only thing
	-- that can end the run.
	timeoutMs: number?,
}

--[=[
	Runs `fn` on its own thread and returns `pcall`'s `(ok, value)` for it, or
	`(false, <abort message>, <timed out>)` when the run is abandoned while it
	is still parked — because the warning arrived, or because its budget
	elapsed. The third value tells those two apart; the caller reports a
	project that ran out of time apart from one that failed.

	`options.onAbandon` is how the caller ends the work `fn` was waiting on.
	`fn`'s own thread parks in `Promise:expect()`, one remove from the thread the
	engine left inside `WaitForChild` — that one belongs to the promise, and
	only its owner can reach it. A caller that runs Jest cancels the `runCLI`
	promise here.

	The budget is the whole guarded span, not Jest's alone: a package that
	spends its minute resolving instances has spent the minute either way, and
	the caller measures the span it wants bounded by choosing what to wrap.

	The warning is a reason to stop waiting rather than a verdict of its own: a
	`fn` that reached its end despite one keeps the result it produced — and so
	does one that finished on the same frame its budget elapsed.

	The caller is woken by a resume, not by a poll, so a run that ends normally
	pays nothing for the watch — a workspace batch guards every package it
	takes.

	`MessageOut` carries no source identity and reaches every listener in the
	DataModel, so concurrent guards cannot tell whose yield they saw: under the
	plugin's parallel VM hosts one project's park ends them all. Single-caller
	modes — the whole of open cloud — are unaffected.
]=]
function module.guard(fn: () -> any, options: Options?): (boolean, any, boolean)
	local settings: Options = options or {}
	local finished = false
	local ok = false
	local value: any = nil
	local warning: string? = nil
	local waiting: thread? = nil
	-- The budget that ran out, so the abort can name the number the reader
	-- raises. Nil while the run is still within it.
	local expiredSeconds: number? = nil

	-- Cleared as it wakes, which is what makes a second wake a no-op: an
	-- abandoned `fn` whose child does turn up after all still runs to its end
	-- and calls this, long after the caller it would have resumed returned.
	local function wake()
		local parked = waiting
		waiting = nil
		if parked ~= nil then
			task.spawn(parked)
		end
	end

	-- Connected before `fn` starts so the watch spans the whole run, and
	-- disconnected before returning so a warning between runs is nobody's.
	local connection = LogService.MessageOut:Connect(
		function(message: string, messageType: Enum.MessageType)
			if
				messageType == MESSAGE_WARNING
				and warning == nil
				and string.find(message, WARNING_NEEDLE, 1, true) ~= nil
			then
				warning = message
				wake()
			end
		end
	)

	-- Armed before the worker starts, because `task.spawn` runs `fn` up to its
	-- first yield before it returns: a deadline armed after that call would
	-- start the budget at the first yield, and a package that spends 50s
	-- resolving instances before parking would get a further 60s. Zero is how a
	-- config asks for no budget. Seconds are converted here, once, rather than
	-- in each mode's runner.
	local budgetMs = settings.timeoutMs
	local budgetSeconds = if budgetMs ~= nil then budgetMs / 1000 else nil
	local deadline: thread? = nil
	if budgetSeconds ~= nil and budgetSeconds > 0 then
		deadline = task.delay(budgetSeconds, function()
			expiredSeconds = budgetSeconds
			wake()
		end)
	end

	local worker = task.spawn(function()
		ok, value = pcall(fn)
		finished = true
		wake()
	end)

	-- `fn` yields the moment it waits on anything, which hands control back
	-- here; a `fn` that never yields at all has already finished by now. A
	-- budget that ran out during that first turn resumed nobody — the caller
	-- was not parked yet — so it is read here rather than waited for, or the
	-- run would park past the deadline it just missed.
	if not finished and warning == nil and expiredSeconds == nil then
		waiting = coroutine.running()
		coroutine.yield()
	end

	connection:Disconnect()

	-- Disarmed only when it did not fire: `wake` resumes this thread from
	-- inside the delay, so a fired deadline IS the thread running this line and
	-- cancelling it would end the run here, before the verdict is returned.
	if deadline ~= nil and expiredSeconds == nil then
		task.cancel(deadline)
	end

	if not finished then
		-- Both threads have to end, and `onAbandon` is the one that matters:
		-- closing `worker` alone leaves the promise executor it waits on still
		-- parked inside `WaitForChild`. A batch stages the next package at the
		-- same DataModel paths, so that child can still turn up — and the
		-- executor would then finish its own package's tests over the live
		-- one's shared state: jest's `_G` run state, the coverage sink, the
		-- snapshot mock.
		--
		-- Cleanup cannot change the verdict, so it runs under pcall.
		local onAbandon = settings.onAbandon
		if onAbandon ~= nil then
			pcall(onAbandon)
		end

		coroutine.close(worker)

		if expiredSeconds ~= nil then
			return false, string.format(TIMEOUT_FORMAT, expiredSeconds), true
		end

		return false, ABORT_PREFIX .. tostring(warning), false
	end

	return ok, value, false
end

return module
