--!strict
local json = require("@std/json")
local process = require("@std/process")

-- src/config/luau-config-lute.ts fills the placeholders below when it
-- writes this file.
local VALUE_SENTINEL = "__VALUE_SENTINEL__"
local ERROR_SENTINEL = "__ERROR_SENTINEL__"

type Unserializable = { path: string, type: string }

local function childPath(parent: string, key: string | number): string
	if type(key) == "number" then
		return `{parent}[{key}]`
	end

	return if parent == "" then key :: string else `{parent}.{key}`
end

local function toJson(
	value: unknown,
	keyPath: string,
	seen: { [any]: boolean }
): (any, Unserializable?)
	local valueType = type(value)
	if valueType == "string" or valueType == "boolean" then
		return value, nil
	end

	if valueType == "number" then
		local number = value :: number
		if number ~= number or number == math.huge or number == -math.huge then
			return nil, { path = keyPath, type = "a number that is not finite" }
		end

		return number, nil
	end

	if valueType ~= "table" then
		return nil, { path = keyPath, type = `a {typeof(value)}` }
	end

	local tableValue = value :: { [any]: unknown }
	if seen[tableValue] then
		return nil, { path = keyPath, type = "a table that holds itself" }
	end

	seen[tableValue] = true
	local stringKeys = 0
	local numberKeys = 0
	for key in tableValue do
		local keyType = type(key)
		if keyType == "string" then
			stringKeys += 1
		elseif keyType == "number" then
			numberKeys += 1
		else
			return nil, { path = keyPath, type = `a table with a {keyType} key` }
		end
	end

	local result: { [any]: any }
	if stringKeys > 0 and numberKeys > 0 then
		return nil, { path = keyPath, type = "a table that mixes list and record entries" }
	elseif numberKeys == 0 then
		result = json.object({})
	elseif #tableValue == numberKeys then
		result = {}
	else
		return nil, { path = keyPath, type = "a list with gaps" }
	end

	for key, entry in tableValue do
		local converted, problem = toJson(entry, childPath(keyPath, key), seen)
		if problem then
			return nil, problem
		end

		result[key] = converted
	end

	seen[tableValue] = nil
	return result, nil
end

local function report(payload: string)
	print("\n" .. payload)
end

local ok, config = pcall(function()
	local loaded = require("@__CONFIG_DIRECTORY_ALIAS__/" .. process.args[#process.args])
	if type(loaded) == "function" then
		return loaded()
	end

	return loaded
end)

if not ok then
	report(ERROR_SENTINEL .. json.serialize({ kind = "evaluate", message = tostring(config) }))
elseif type(config) ~= "table" then
	report(ERROR_SENTINEL .. json.serialize({ kind = "root", type = `a {typeof(config)}` }))
else
	local value, problem = toJson(config, "", {})
	if problem then
		report(
			ERROR_SENTINEL
				.. json.serialize({ kind = "serialize", path = problem.path, type = problem.type })
		)
	else
		report(VALUE_SENTINEL .. json.serialize(value))
	end
end
