--!strict
-- Game Output capture: everything LogService.MessageOut reports (native
-- print/warn, engine warnings, Jest's own writes) between `start` and the stop
-- function it returns, JSON-encoded as `{ message, messageType, timestamp }`
-- records. Surfaced to users via `--gameOutput <path>`.
--
-- Shared by runner.luau (multi) and staging/embedded-runner.luau (workspace)
-- so the two dispatch modes cannot drift on what a capture holds.
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

local InterceptWriteable = require("./intercept-writeable")

type CapturedMessage = InterceptWriteable.CapturedMessage

-- What a `note` is filed as, so a line this module writes itself is
-- indistinguishable from the one its own print reports.
local MESSAGE_OUTPUT = Enum.MessageType.MessageOutput.Value

local module = {}

-- The buffer of every capture currently open. Both dispatch modes hold one at
-- a time — the project's own window — and it is kept as a list only so `note`
-- never has to decide which of them is current.
local openBuffers: { { CapturedMessage } } = {}

-- The line `note` has already filed, waiting for the deferred `MessageOut` its
-- own print fires. Dropped wherever that lands, because by then the capture the
-- line belongs to has closed and the open one belongs to whatever ran next.
-- Cleared as it arrives, and superseded by the next `note`. A user `print` of
-- byte-identical text inside that window is dropped with it; accepted.
local pendingEcho: string? = nil

-- Returns the stop function: it disconnects the listener and returns the
-- encoded buffer, or nil when nothing was reported (or the encode failed), so
-- a silent run adds no field to its envelope. Call it exactly once, as late as
-- possible — warns that fire as Promise:expect resumes the coroutine arrive
-- after the run itself has returned.
function module.start(): () -> string?
	local logMessages: { CapturedMessage } = {}
	table.insert(openBuffers, logMessages)

	local connection = LogService.MessageOut:Connect(
		function(message: string, messageType: Enum.MessageType)
			if message == pendingEcho then
				pendingEcho = nil
				return
			end

			table.insert(logMessages, {
				message = message,
				messageType = messageType.Value,
				timestamp = os.clock(),
			})
		end
	)

	return function(): string?
		connection:Disconnect()

		local index = table.find(openBuffers, logMessages)
		if index ~= nil then
			table.remove(openBuffers, index)
		end

		if #logMessages == 0 then
			return nil
		end

		local encodeOk, encoded = pcall(function()
			return HttpService:JSONEncode(logMessages)
		end)
		return if encodeOk then encoded :: string else nil
	end
end

--[=[
	File one line under every capture that is open, and print it.

	Written to the buffers directly because `MessageOut` delivers deferred: a
	print on its own lands a scheduler turn later, inside whatever window
	opened next. The print stays because a run that outran its whole Open Cloud
	deadline returns no envelope, so the task log tail is all the reader has.

	@param message -- The line to file.
]=]
function module.note(message: string)
	local timestamp = os.clock()
	for _, buffer in openBuffers do
		table.insert(buffer, {
			message = message,
			messageType = MESSAGE_OUTPUT,
			timestamp = timestamp,
		})
	end

	-- Armed only when the line was filed. With no capture open nothing is
	-- duplicated, and no listener exists to clear the slot either — it would
	-- outlive the print and swallow the next capture's first matching line.
	if #openBuffers > 0 then
		pendingEcho = message
	end

	print(message)
end

return module
