local attempt = "__RESULT_RELAY_ATTEMPT__"
-- __RESULT_RELAY_RUNTIME_BUDGET__
local relayStart = os.clock()

local function publish(success, outputs, deadline)
	local HttpService = game:GetService("HttpService")
	local MemoryStoreService = game:GetService("MemoryStoreService")
	local EncodingService = game:GetService("EncodingService")
	local relay = MemoryStoreService:GetSortedMap("jest-roblox-result-relay-v1")
	local payload = { error = outputs }
	if success then
		payload = {}
		for index = 1, outputs.n do
			if typeof(outputs[index]) ~= "string" then return end
			payload[index] = outputs[index]
		end
	end
	local json = HttpService:JSONEncode(payload)
	local compressed = EncodingService:CompressBuffer(buffer.fromstring(json), Enum.CompressionAlgorithm.Zstd, 3)
	local encoded = buffer.tostring(EncodingService:Base64Encode(compressed))
	local chunkSize = 3500
	local chunkCount = math.ceil(#encoded / chunkSize)
	for sequence = 1, chunkCount do
		local key = attempt .. ":" .. tostring(sequence)
		relay:SetAsync(key, {
			version = 1, attempt = attempt, sequence = sequence, chunkCount = chunkCount,
			uncompressedLength = #json,
			data = string.sub(encoded, (sequence - 1) * chunkSize + 1, sequence * chunkSize),
		}, 120)
		local acknowledged = false
		local acknowledgementDeadline = math.min(deadline, os.clock() + 5)
		while os.clock() < acknowledgementDeadline do
			if relay:GetAsync(key) == nil then acknowledged = true break end
			task.wait(0.1)
		end
		if not acknowledged then return end
	end
end

local function original(...)
-- __RESULT_RELAY_SCRIPT__
end
local arguments = table.pack(...)
local success, outputs = xpcall(function()
	return table.pack(original(table.unpack(arguments, 1, arguments.n)))
end, function(message)
	return debug.traceback(tostring(message), 2)
end)
local remaining = publishBudgetSeconds - (os.clock() - relayStart) - 2
if remaining > 0 then
	local deadline = os.clock() + math.min(60, remaining)
	local done = false
	local publisher = task.spawn(function()
		pcall(publish, success, outputs, deadline)
		done = true
	end)
	while not done and os.clock() < deadline do task.wait(0.05) end
	if not done then pcall(task.cancel, publisher) end
end
if not success then error(outputs, 0) end
return table.unpack(outputs, 1, outputs.n)
