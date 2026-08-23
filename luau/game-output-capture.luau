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

local module = {}

-- Returns the stop function: it disconnects the listener and returns the
-- encoded buffer, or nil when nothing was reported (or the encode failed), so
-- a silent run adds no field to its envelope. Call it exactly once, as late as
-- possible — warns that fire as Promise:expect resumes the coroutine arrive
-- after the run itself has returned.
function module.start(): () -> string?
	local logMessages: { CapturedMessage } = {}
	local connection = LogService.MessageOut:Connect(
		function(message: string, messageType: Enum.MessageType)
			table.insert(logMessages, {
				message = message,
				messageType = messageType.Value,
				timestamp = os.clock(),
			})
		end
	)

	return function(): string?
		connection:Disconnect()
		if #logMessages == 0 then
			return nil
		end

		local encodeOk, encoded = pcall(function()
			return HttpService:JSONEncode(logMessages)
		end)
		return if encodeOk then encoded :: string else nil
	end
end

return module
