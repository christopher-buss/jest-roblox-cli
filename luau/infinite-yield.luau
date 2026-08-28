--!strict
-- Infinite-yield watchdog, shared by both dispatch modes: `runner.luau` for a
-- multi run and `staging/embedded-runner.luau` for a workspace one.
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
-- Hoisted: the handler runs on every line the run logs.
local MESSAGE_WARNING = Enum.MessageType.MessageWarning

local module = {}

--[=[
	Runs `fn` on its own thread and returns `pcall`'s `(ok, value)` for it, or
	`(false, <abort message>)` when the warning arrives while it is still
	parked.

	`onAbandon` is how the caller ends the work `fn` was waiting on. `fn`'s own
	thread parks in `Promise:expect()`, one remove from the thread the engine
	left inside `WaitForChild` — that one belongs to the promise, and only its
	owner can reach it. A caller that runs Jest cancels the `runCLI` promise
	here.

	The warning is a reason to stop waiting rather than a verdict of its own: a
	`fn` that reached its end despite one keeps the result it produced.

	The caller is woken by a resume, not by a poll, so a run that ends normally
	pays nothing for the watch — a workspace batch guards every package it
	takes.

	`MessageOut` carries no source identity and reaches every listener in the
	DataModel, so concurrent guards cannot tell whose yield they saw: under the
	plugin's parallel VM hosts one project's park ends them all. Single-caller
	modes — the whole of open cloud — are unaffected.
]=]
function module.guard(fn: () -> any, onAbandon: (() -> ())?): (boolean, any)
	local finished = false
	local ok = false
	local value: any = nil
	local warning: string? = nil
	local waiting: thread? = nil

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

	local worker = task.spawn(function()
		ok, value = pcall(fn)
		finished = true
		wake()
	end)

	-- `fn` yields the moment it waits on anything, which hands control back
	-- here; a `fn` that never yields at all has already finished by now.
	if not finished and warning == nil then
		waiting = coroutine.running()
		coroutine.yield()
	end

	connection:Disconnect()

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
		if onAbandon ~= nil then
			pcall(onAbandon)
		end

		coroutine.close(worker)
		return false, ABORT_PREFIX .. tostring(warning)
	end

	return ok, value
end

return module
