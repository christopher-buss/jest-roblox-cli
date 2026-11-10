--!strict
-- No Roblox globals: test/luau/vm-parallel.harness.luau runs this under Lute.
local Envelope = require("./envelope")

local module = {}

export type ProjectEntry = {
	bannerOutput: string,
	elapsedMs: number,
	gameOutput: string?,
	jestOutput: string,
	jobIndex: number?,
}

export type Encode = (value: any) -> string

export type FailureRequest = {
	elapsedMs: number?,
	encode: Encode,
	message: string,
}

export type SliceRequest = {
	configCount: number,
	hostCount: number,
	-- Parallel to the configs.
	mounts: { { string } }?,
}

export type FinalizeRequest = {
	configCount: number,
	encode: Encode,
	missingError: string?,
	received: { [number]: ProjectEntry },
}

local DEFAULT_MISSING_ERROR = "The VM host running this project returned no result"

local DEFAULT_RUN_BUDGET_MS = require("./protocol").limits.runTimeoutMs

local HOST_BUDGET_RATIO = 0.8

local MIN_HOST_DEADLINE_SECONDS = 30

function module.resolveHostDeadlineSeconds(runBudgetMs: number?): number
	local budgetSeconds = (runBudgetMs or DEFAULT_RUN_BUDGET_MS) / 1000
	return math.max(MIN_HOST_DEADLINE_SECONDS, budgetSeconds * HOST_BUDGET_RATIO)
end

local function isAtOrUnder(path: string, candidate: string): boolean
	if candidate == path then
		return true
	end

	return #candidate > #path and string.sub(candidate, 1, #path + 1) == path .. "/"
end

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

function module.planSlices(request: SliceRequest): { { number } }
	local configCount = request.configCount
	local groupOf = groupColludingConfigs(configCount, request.mounts or {})

	local hostOfGroup: { [number]: number } = {}
	local groupCount = 0
	for index = 1, configCount do
		if hostOfGroup[groupOf[index]] == nil then
			groupCount += 1
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

function module.failureEntry(request: FailureRequest): ProjectEntry
	return {
		bannerOutput = "[]",
		elapsedMs = request.elapsedMs or 0,
		jestOutput = request.encode(Envelope.failure(request.message)),
	}
end

function module.workspaceErrorEntry(
	entry: {
		pkg: string,
		project: string,
		config: { runnerJobIndex: number? },
	},
	request: FailureRequest
): any
	local result: any = module.failureEntry(request)
	result.jobIndex = entry.config.runnerJobIndex
	result.pkg = entry.pkg
	result.project = entry.project
	return result
end

function module.finalizeEntries(request: FinalizeRequest): { ProjectEntry }
	local entries: { ProjectEntry } = {}
	for index = 1, request.configCount do
		local entry = request.received[index]
		if entry == nil then
			entry = module.failureEntry({
				encode = request.encode,
				message = request.missingError or DEFAULT_MISSING_ERROR,
			})
		end

		entries[index] = entry
	end

	return entries
end

return module
