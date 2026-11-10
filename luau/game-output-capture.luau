--!strict
-- Shared by runner.luau and staging/embedded-runner.luau.
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

local InterceptWriteable = require("./intercept-writeable")

type CapturedMessage = InterceptWriteable.CapturedMessage

local MESSAGE_OUTPUT = Enum.MessageType.MessageOutput.Value

local module = {}

local openBuffers: { { CapturedMessage } } = {}

-- Holds the line `note` filed until its deferred `MessageOut` echo lands.
local pendingEcho: string? = nil

-- Call the stop function once, as late as possible: late warns arrive after
-- the run returns.
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

function module.note(message: string)
	local timestamp = os.clock()
	for _, buffer in openBuffers do
		table.insert(buffer, {
			message = message,
			messageType = MESSAGE_OUTPUT,
			timestamp = timestamp,
		})
	end

	-- Armed only when filed: with no capture open, no listener clears it.
	if #openBuffers > 0 then
		pendingEcho = message
	end

	print(message)
end

return module
