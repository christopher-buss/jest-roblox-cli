--!strict
-- Mirrors @rbxts-js/roblox-shared/src/normalizePromiseError.lua: when Jest's
-- internal Promise chain rejects (e.g. process.exit fires via nodeUtils:25),
-- the rejection value is a Promise.Error table whose `.error` field at every
-- non-leaf level is `tostring(parent)` — the upstream Promise.Error
-- __tostring blob. Walking to the deepest parent recovers the original cause
-- string ("Exited with code: 1") instead of a multi-frame trace. Depth-capped
-- to defend against future cycles (a Promise.Error pointing at itself would
-- otherwise hang the test task until the infinite-yield watchdog fires).

local module = {}

local MAX_PROMISE_ERROR_DEPTH = 64

-- Single-line Luau path:line prefix, e.g. `Module.Path:25: <msg>`. We strip
-- this so the CLI banner's exit-code branch (^Exited with code: \d+$) can
-- match the surfaced message and demote the transport line to a footer.
local PATH_LINE_PREFIX = "^[%w_%.@%-/]+:%d+:%s*"

local function stripPathLinePrefix(message: string): string
	-- Multi-line strings keep their full content — only strip when the
	-- entire string is the single `<path>:<line>: <msg>` shape so we don't
	-- swallow useful context from layered messages.
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
