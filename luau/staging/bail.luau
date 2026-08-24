--!strict
-- Fail-fast across a workspace batch (`--bail`).
--
-- A task stops taking packages the moment one of them fails. On its own that
-- only covers the packages this task would have run; the rest of the batch is
-- being drained concurrently by sibling tasks against the same queue, and Open
-- Cloud exposes no way to cancel a running task from outside. So the trip is
-- also broadcast: the first task to fail writes into a per-run SortedMap the
-- whole wave shares, and every task reads it before it pops again. Each task
-- then ends itself, which is the only cancellation available.
--
-- Both halves are best effort by design. A broadcast that fails still stops the
-- task that failed, and a read that fails reads as "nobody has failed" — the
-- run degrades to per-task bail rather than dying inside the pop loop.
local module = {}

-- The signal lives in a map of its own (`bailMapId`), separate from the
-- streaming results map, so the key never has to avoid colliding with a package
-- entry and the CLI never has to skip it while draining results.
local SIGNAL_KEY = "signal"

module.SIGNAL_KEY = SIGNAL_KEY

export type SignalMap = {
	GetAsync: (self: any, key: string) -> any,
	SetAsync: (self: any, key: string, value: any, expiration: number) -> ...any,
}

--[=[
	How one task's bail is set up.

	An options table rather than three optional positionals: two of the three are
	absent on the single-task path, and `new(nil, nil, 600)` says nothing about
	which.
]=]
export type Options = {
	enabled: boolean?,
	-- The wave's shared signal map. Absent on the single-task path: no siblings
	-- to tell, so the decision stays local.
	map: SignalMap?,
	ttlSeconds: number?,
}

export type State = {
	enabled: boolean,
	map: SignalMap?,
	ttlSeconds: number,
	tripped: boolean,
}

--[=[
	Track one task's bail decision.
]=]
function module.new(options: Options): State
	return {
		enabled = options.enabled == true,
		map = options.map,
		ttlSeconds = options.ttlSeconds or 600,
		tripped = false,
	}
end

--[=[
	Whether this task is running under `--bail` at all.

	Callers use it to skip work only the bail decision needs — decoding a
	package's Jest output to learn whether it passed, most of all.
]=]
function module.isEnabled(state: State): boolean
	return state.enabled
end

--[=[
	Record how one package finished, tripping and broadcasting on a failure.
]=]
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

--[=[
	Whether this task should stop taking packages — because it failed one
	itself, or because a sibling says it did.
]=]
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
