--!strict
--[[
	The dispatch arithmetic behind an in-session parallel run: which configs go
	to which VM host, and how the entries they send back become the one
	request-ordered array the response envelope carries.

	Deliberately free of Roblox globals — `encode` arrives as a dependency — so
	the half of the coordinator that is easy to get wrong runs under Lute
	(`test/luau/vm-parallel.harness.luau`, driven by the
	`test/luau/vm-parallel.spec.ts` wrapper) rather than only inside a Studio
	session.
]]
local module = {}

export type ProjectEntry = {
	bannerOutput: string,
	elapsedMs: number,
	gameOutput: string?,
	jestOutput: string,
}

export type Encode = (value: any) -> string

export type ExecutionErrorRequest = {
	elapsedMs: number?,
	encode: Encode,
	message: string,
}

export type SliceRequest = {
	configCount: number,
	hostCount: number,
	--[[
		Each config's runtime `jest.config` mount paths, parallel to the
		configs. Optional: without it every config is independent and the
		split is plain round-robin.
	]]
	mounts: { { string } }?,
}

export type FinalizeRequest = {
	configCount: number,
	encode: Encode,
	--[[
		Why a config has no entry, rendered into the entries left standing.
		Only a host that died or never answered leaves one, so the default
		says exactly that.
	]]
	missingError: string?,
	received: { [number]: ProjectEntry },
}

local DEFAULT_MISSING_ERROR = "The VM host running this project returned no result"

--[[
	The run budget assumed when the payload carries none. Matches the CLI's own
	default run timeout, so the two agree unless the caller says otherwise.
]]
local DEFAULT_RUN_BUDGET_MS = 300000

--[[
	The share of the run budget the coordinator may spend waiting for hosts.
	The rest pays for what the CLI's clock covers but the coordinator's does
	not: launching Studio, opening the place, and carrying the result back.

	A tuning surface. Too high and the CLI stops listening before the partial
	results arrive; too low and a long but healthy slice is declared dead.
]]
local HOST_BUDGET_RATIO = 0.8

--[[
	The shortest wait worth having, whatever the budget says. A caller with a
	very small timeout gets a run that fails on the CLI's clock rather than one
	the coordinator abandons before Jest has finished starting.
]]
local MIN_HOST_DEADLINE_SECONDS = 30

--[[
	How long the coordinator may wait for its hosts, in seconds, given the run
	budget the CLI sent in milliseconds.

	Bounded by that budget on purpose: the coordinator's whole reason for having
	a deadline is to turn a dead host into ExecutionError entries the CLI can
	still render, and a deadline past the CLI's own timeout delivers nothing —
	the CLI has already given up (and studio-cli has killed Studio).
]]
function module.resolveHostDeadlineSeconds(runBudgetMs: number?): number
	local budgetSeconds = (runBudgetMs or DEFAULT_RUN_BUDGET_MS) / 1000
	return math.max(MIN_HOST_DEADLINE_SECONDS, budgetSeconds * HOST_BUDGET_RATIO)
end

--[[
	Whether `candidate` is `path` itself or sits beneath it.

	Segment-wise, not a string prefix: `ReplicatedStorage/Foo` does not contain
	`ReplicatedStorage/Foobar`, and treating it as though it did would pin two
	unrelated projects to one host.
]]
local function isAtOrUnder(path: string, candidate: string): boolean
	if candidate == path then
		return true
	end

	return #candidate > #path and string.sub(candidate, 1, #path + 1) == path .. "/"
end

--[[
	Whether two configs' mount paths would put a `jest.config` stub in the
	DataModel where the other config's Jest could find it.
]]
local function mountsCollide(left: { string }, right: { string }): boolean
	for _, leftPath in left do
		for _, rightPath in right do
			if isAtOrUnder(leftPath, rightPath) or isAtOrUnder(rightPath, leftPath) then
				return true
			end
		end
	end

	return false
end

--[[
	Group configs that must not run at the same time.

	Two configs whose mounts nest — `ReplicatedStorage` and
	`ReplicatedStorage/Foo` — must never have their `jest.config` stubs in the
	DataModel simultaneously, or Jest's parent-traversal config lookup resolves
	the wrong project's config. The runner already serialises that within a
	host (inject, run, clean up, next config), so the fix is to keep such
	configs on one host. Grouping is transitive: A nests with B and B with C
	puts all three together, because any two of them could otherwise overlap.

	Returns a group id per config; independent configs each get their own.
]]
local function groupColludingConfigs(configCount: number, mounts: { { string } }): { number }
	local groupOf: { number } = {}
	for index = 1, configCount do
		groupOf[index] = index
	end

	for index = 2, configCount do
		for earlier = 1, index - 1 do
			if mountsCollide(mounts[index] or {}, mounts[earlier] or {}) then
				local absorbed = groupOf[index]
				local survivor = groupOf[earlier]
				if absorbed ~= survivor then
					for other = 1, configCount do
						if groupOf[other] == absorbed then
							groupOf[other] = survivor
						end
					end
				end
			end
		end
	end

	return groupOf
end

--[[
	Assign configs to at most `hostCount` hosts round-robin: config 1 to host 1,
	config 2 to host 2, and so on, wrapping around.

	Round-robin rather than contiguous blocks because config order tends to
	track cost (the big project first, its small siblings after), so
	alternating spreads that cost instead of stacking it on one host.

	Configs whose stub mounts nest travel together and count as one stop in the
	rotation, so they run one after another on their shared host. Returns one
	slice per host that has work — never an empty slice, so the coordinator
	dispatches to exactly as many hosts as it can use.
]]
function module.planSlices(request: SliceRequest): { { number } }
	local configCount = request.configCount
	local groupOf = groupColludingConfigs(configCount, request.mounts or {})

	local hostOfGroup: { [number]: number } = {}
	local groupCount = 0
	for index = 1, configCount do
		if hostOfGroup[groupOf[index]] == nil then
			groupCount += 1
			-- Placeholder: the host number needs the final group count, which
			-- this pass is still counting.
			hostOfGroup[groupOf[index]] = groupCount
		end
	end

	local usable = math.min(request.hostCount, groupCount)
	local slices: { { number } } = {}
	if usable < 1 then
		return slices
	end

	for host = 1, usable do
		slices[host] = {}
	end

	for index = 1, configCount do
		local host = (hostOfGroup[groupOf[index]] - 1) % usable + 1
		table.insert(slices[host], index)
	end

	return slices
end

--[[
	The ExecutionError entry the CLI renders when one project could not run at
	all. Mirrors the shape `Runner.runProjects` already produces for a config
	that threw, so the parser needs nothing new to read it.
]]
function module.executionErrorEntry(request: ExecutionErrorRequest): ProjectEntry
	return {
		bannerOutput = "[]",
		elapsedMs = request.elapsedMs or 0,
		jestOutput = request.encode({
			success = true,
			value = {
				kind = "ExecutionError",
				error = request.message,
			},
		}),
	}
end

--[[
	Flatten what the hosts sent into request order.

	Hosts finish in whatever order their projects happen to end, and a host
	that died sends nothing at all. Both are handled here: entries are keyed by
	their config index on the way in, and any index still missing becomes an
	ExecutionError entry so the envelope stays parallel to the configs the CLI
	sent.
]]
function module.finalizeEntries(request: FinalizeRequest): { ProjectEntry }
	local entries: { ProjectEntry } = {}
	for index = 1, request.configCount do
		local entry = request.received[index]
		if entry == nil then
			entry = module.executionErrorEntry({
				encode = request.encode,
				message = request.missingError or DEFAULT_MISSING_ERROR,
			})
		end

		entries[index] = entry
	end

	return entries
end

return module
