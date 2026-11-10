--!strict
local LogService = game:GetService("LogService")

local Protocol = require("./protocol")

local WARNING_NEEDLE = "Infinite yield possible"
local ABORT_PREFIX = "Infinite yield detected, aborting tests: "
local MESSAGE_WARNING = Enum.MessageType.MessageWarning

local function withNote(message: string, note: (() -> string)?): string
	if note == nil then
		return message
	end

	local ok, text = pcall(note)
	if not ok or type(text) ~= "string" or text == "" then
		return message
	end

	return message .. ". " .. text
end

local module = {}

export type Options = {
	abandonNote: (() -> string)?,
	onAbandon: (() -> ())?,
	timeoutMs: number?,
}

function module.guard(fn: () -> any, options: Options?): (boolean, any, string?)
	local settings: Options = options or {}
	local finished = false
	local ok = false
	local value: any = nil
	local warning: string? = nil
	local waiting: thread? = nil
	local expiredSeconds: number? = nil

	-- Cleared as it wakes, so a late second wake is a no-op.
	local function wake()
		local parked = waiting
		waiting = nil
		if parked ~= nil then
			task.spawn(parked)
		end
	end

	-- Connect before `fn` starts; disconnect before returning.
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

	-- Arm before the worker: `task.spawn` runs `fn` to its first yield.
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

	-- A budget spent before the first yield resumed nobody; read it here.
	if not finished and warning == nil and expiredSeconds == nil then
		waiting = coroutine.running()
		coroutine.yield()
	end

	connection:Disconnect()

	-- Disarm only if unfired: a fired deadline is the thread running here.
	if deadline ~= nil and expiredSeconds == nil then
		task.cancel(deadline)
	end

	if not finished then
		-- `onAbandon` must run: closing `worker` alone leaves the executor
		-- parked in `WaitForChild`, where it can finish over the next package.
		-- Cleanup cannot change the verdict, so it runs under pcall.
		local onAbandon = settings.onAbandon
		if onAbandon ~= nil then
			pcall(onAbandon)
		end

		coroutine.close(worker)

		local note = settings.abandonNote
		if expiredSeconds ~= nil then
			return false,
				withNote(string.format(Protocol.timeoutFormat, expiredSeconds), note),
				Protocol.errorCodes.Timeout
		end

		return false,
			withNote(ABORT_PREFIX .. tostring(warning), note),
			Protocol.errorCodes.InfiniteYield
	end

	return ok, value, nil
end

return module
