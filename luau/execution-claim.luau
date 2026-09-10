do
	local key, startBefore, retention, notClaimed, startExpired = __EXECUTION_CLAIM_PARAMETERS__
	local owner = game:GetService("HttpService"):GenerateGUID(false)
	local claims = game:GetService("MemoryStoreService"):GetHashMap("jest-roblox-execution-v1")
	local success, result
	for attempt = 1, 3 do
		success, result = pcall(function()
			-- Retention must outlast the client deadline on Roblox's clock.
			local remaining = math.ceil((startBefore - DateTime.now().UnixTimestampMillis) / 1000)
			return claims:UpdateAsync(key, function(current)
				-- A delayed task cannot reclaim a key after its retention expires.
				if DateTime.now().UnixTimestampMillis >= startBefore then
					return nil
				end
				if current ~= nil and current ~= owner then
					return nil
				end
				return owner
			end, math.max(retention, remaining + 60))
		end)
		if success then
			break
		end
		if attempt < 3 then
			task.wait(0.1 * attempt)
		end
	end
	if not success then
		error("Could not claim test execution: " .. tostring(result))
	end
	if result ~= owner then
		if DateTime.now().UnixTimestampMillis >= startBefore then
			return startExpired
		end
		return notClaimed
	end
end
