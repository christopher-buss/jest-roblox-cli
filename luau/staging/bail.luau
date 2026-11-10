--!strict
local QUEUE_TTL_SECONDS = require("../protocol").limits.queueTtlSeconds

local module = {}

local SIGNAL_KEY = "signal"

module.SIGNAL_KEY = SIGNAL_KEY

export type SignalMap = {
	GetAsync: (self: any, key: string) -> any,
	SetAsync: (self: any, key: string, value: any, expiration: number) -> ...any,
}

export type Options = {
	enabled: boolean?,
	map: SignalMap?,
	ttlSeconds: number?,
}

export type State = {
	enabled: boolean,
	map: SignalMap?,
	ttlSeconds: number,
	tripped: boolean,
}

function module.new(options: Options): State
	return {
		enabled = options.enabled == true,
		map = options.map,
		ttlSeconds = options.ttlSeconds or QUEUE_TTL_SECONDS,
		tripped = false,
	}
end

function module.isEnabled(state: State): boolean
	return state.enabled
end

function module.observe(state: State, success: boolean)
	if not state.enabled or success or state.tripped then
		return
	end

	state.tripped = true

	local map = state.map
	if map == nil then
		return
	end

	pcall(function()
		map:SetAsync(SIGNAL_KEY, { bailed = true }, state.ttlSeconds)
	end)
end

function module.shouldStop(state: State): boolean
	if not state.enabled then
		return false
	end

	if state.tripped then
		return true
	end

	local map = state.map
	if map == nil then
		return false
	end

	local ok, signal = pcall(function()
		return map:GetAsync(SIGNAL_KEY)
	end)

	if ok and signal ~= nil then
		state.tripped = true
	end

	return state.tripped
end

return module
