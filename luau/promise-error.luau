--!strict
-- Mirrors @rbxts-js/roblox-shared/src/normalizePromiseError.lua.
local module = {}

local MAX_PROMISE_ERROR_DEPTH = 64

-- Stripped so the CLI banner's `^Exited with code: \d+$` branch matches.
local PATH_LINE_PREFIX = "^[%w_%.@%-/]+:%d+:%s*"

local function stripPathLinePrefix(message: string): string
	if string.find(message, "\n", 1, true) ~= nil then
		return message
	end

	local stripped, replacements = string.gsub(message, PATH_LINE_PREFIX, "", 1)
	if replacements > 0 then
		return stripped
	end

	return message
end

function module.normalize(err: any): string
	if type(err) ~= "table" then
		return stripPathLinePrefix(tostring(err))
	end

	local current: any = err
	for _ = 1, MAX_PROMISE_ERROR_DEPTH do
		if type(current.parent) ~= "table" then
			break
		end

		current = current.parent
	end

	if type(current.error) == "string" then
		return stripPathLinePrefix(current.error)
	end

	return stripPathLinePrefix(tostring(err))
end

return module
