--!strict
local module = {}

export type CapturedMessage = { message: string, messageType: number, timestamp: number }

function module.intercept(
	writeable: any,
	buffer: { CapturedMessage },
	messageType: number
): () -> ()
	local original = writeable._writeFn
	if typeof(original) ~= "function" then
		return function() end
	end

	writeable._writeFn = function(data: string)
		table.insert(buffer, {
			message = data,
			messageType = messageType,
			timestamp = os.clock(),
		})
		original(data)
	end

	return function()
		writeable._writeFn = original
	end
end

return module
