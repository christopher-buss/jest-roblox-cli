--!strict
-- Shared by staging/entry.luau and plugin/src/test-in-run-mode.server.luau.
local HttpService = game:GetService("HttpService")
local MemoryStoreService = game:GetService("MemoryStoreService")

local Bail = require("./bail")
local GameOutputCapture = require("../game-output-capture")
local Materializer = require("./materializer")
local PromiseError = require("../promise-error")
local ResultBudget = require("./result-budget")
local RunOnce = require("../run-once")
local RunnerResult = require("../runner-result")

local Protocol = require("../protocol")
local DEFAULT_QUEUE_TTL_SECONDS = Protocol.limits.queueTtlSeconds
local ENTRY_KEY_SEPARATOR = Protocol.envelope.entryKeySeparator

-- Above the 0 the CLI seeds queue items with.
local REQUEUE_PRIORITY = 1

local REQUEUE_ATTEMPTS = 3
local REQUEUE_BACKOFF_SECONDS = 0.5

export type EntryPayload = {
	pkg: string,
	project: string,
	config: RunOnce.Config,
}

export type Payload = {
	entries: { EntryPayload },
	bail: boolean?,
	bailMapId: string?,
	queueId: string?,
	invisibilityWindowSeconds: number?,
	queueTtlSeconds: number?,
	resultBudgetBytes: number?,
	sortedMapId: string?,
	streamingTtlSeconds: number?,
}

export type RunOutcome = {
	bailed: boolean,
	deferred: boolean,
}

type StopReason = "bailed" | "deferred"

type Run = {
	bail: Bail.State,
	budget: ResultBudget.Tracker,
	payload: Payload,
	results: { ResultEntry },
}

type QueueItem = {
	pkg: string,
	project: string,
}

export type ResultEntry = {
	pkg: string,
	project: string,
	jobIndex: number?,
	elapsedMs: number,
	jestOutput: string,
	gameOutput: string?,
	bannerOutput: string?,
}

type StreamingSummary = {
	pkg: string,
	project: string,
	elapsedMs: number,
	numFailedTests: number,
	numPassedTests: number,
	numPendingTests: number,
	success: boolean,
}

local function buildSummary(result: ResultEntry): StreamingSummary
	local summary: StreamingSummary = {
		pkg = result.pkg,
		project = result.project,
		elapsedMs = result.elapsedMs,
		numFailedTests = 0,
		numPassedTests = 0,
		numPendingTests = 0,
		success = false,
	}

	local parseOk, parsed = pcall(function()
		return HttpService:JSONDecode(result.jestOutput)
	end)
	if not parseOk or type(parsed) ~= "table" or parsed.success ~= true then
		return summary
	end

	local inner = parsed.value
	if type(inner) ~= "table" then
		return summary
	end

	summary.numFailedTests = tonumber(inner.numFailedTests) or 0
	summary.numPassedTests = tonumber(inner.numPassedTests) or 0
	summary.numPendingTests = tonumber(inner.numPendingTests) or 0
	summary.success = inner.success == true
	return summary
end

-- SortedMap items cap at 32 KB, so stream the summary only.
local function streamResult(summary: StreamingSummary, sortedMapId: string?, ttlSeconds: number?)
	if sortedMapId == nil or sortedMapId == "" then
		return
	end

	pcall(function()
		local map = MemoryStoreService:GetSortedMap(sortedMapId)
		local ttl = ttlSeconds or DEFAULT_QUEUE_TTL_SECONDS
		map:SetAsync(summary.pkg .. ENTRY_KEY_SEPARATOR .. summary.project, summary, ttl)
	end)
end

local function summarize(run: Run, result: ResultEntry): StreamingSummary?
	local sortedMapId = run.payload.sortedMapId
	local isStreaming = sortedMapId ~= nil and sortedMapId ~= ""
	if not isStreaming and not Bail.isEnabled(run.bail) then
		return nil
	end

	return buildSummary(result)
end

local function publishEntry(run: Run, result: ResultEntry)
	local summary = summarize(run, result)
	if summary ~= nil then
		local payload = run.payload
		streamResult(summary, payload.sortedMapId, payload.streamingTtlSeconds)
		Bail.observe(run.bail, summary.success)
	end
end

local function stageFailure(entry: EntryPayload, err: any, elapsedMs: number): ResultEntry
	return {
		pkg = entry.pkg,
		project = entry.project,
		jobIndex = entry.config.runnerJobIndex,
		elapsedMs = elapsedMs,
		jestOutput = HttpService:JSONEncode(
			RunnerResult.fail(PromiseError.normalize(err), { phase = Protocol.phases.Staging })
		),
	}
end

type EntryPlacement = {
	hosted: boolean,
	prevPkg: string?,
}

local function executeEntry(
	callingScript: LuaSourceContainer,
	entry: EntryPayload,
	placement: EntryPlacement
): (ResultEntry, string?)
	local hosted, prevPkg = placement.hosted, placement.prevPkg
	local changingPackage = entry.pkg ~= prevPkg

	-- Tear down the previous package before this entry's capture opens.
	local resetOk: boolean, resetErr: any = true, nil
	if changingPackage and prevPkg ~= nil then
		resetOk, resetErr = pcall(Materializer.reset)
	end

	local outcome = RunOnce.runEntry(callingScript, entry.config, {
		capture = not hosted,
		-- Reset inside this package's capture window, before it closes.
		cleanUp = function(run: RunOnce.Outcome?)
			if run ~= nil and run.timedOut and not hosted then
				Materializer.reset()
			end
		end,
		stage = function()
			if not resetOk then
				error(resetErr, 0)
			end

			if changingPackage then
				Materializer.materialize(entry.pkg)
			end
		end,
	})

	local result: ResultEntry = {
		pkg = entry.pkg,
		project = entry.project,
		jobIndex = entry.config.runnerJobIndex,
		elapsedMs = outcome.elapsedMs,
		jestOutput = outcome.jestOutput,
		gameOutput = outcome.gameOutput,
		bannerOutput = outcome.bannerOutput,
	}

	return result, if outcome.timedOut then nil else entry.pkg
end

local function retireRead(queue: any, removeId: any)
	pcall(function()
		queue:RemoveAsync(removeId)
	end)
end

local function requeueRead(queue: any, item: QueueItem, ttlSeconds: number): boolean
	for attempt = 1, REQUEUE_ATTEMPTS do
		local added = pcall(function()
			queue:AddAsync(item, ttlSeconds, REQUEUE_PRIORITY)
		end)
		if added then
			return true
		end

		if attempt < REQUEUE_ATTEMPTS then
			task.wait(REQUEUE_BACKOFF_SECONDS * 2 ^ (attempt - 1))
		end
	end

	return false
end

local function resolveSignalMap(payload: Payload): Bail.SignalMap?
	local bailMapId = payload.bailMapId
	if bailMapId == nil or bailMapId == "" then
		return nil
	end

	local ok, map = pcall(function()
		return MemoryStoreService:GetSortedMap(bailMapId)
	end)

	return if ok then map :: any else nil
end

-- Bail first: a deferral asks the CLI for a new task; a bail asks for none.
local function stopReason(run: Run): StopReason?
	if Bail.shouldStop(run.bail) then
		return "bailed"
	end

	if ResultBudget.shouldStop(run.budget) then
		return "deferred"
	end

	return nil
end

local function newRun(payload: Payload, bail: Bail.State): Run
	return {
		bail = bail,
		budget = ResultBudget.new(payload.resultBudgetBytes),
		payload = payload,
		results = {},
	}
end

local function toOutcome(stop: StopReason?): RunOutcome
	return { bailed = stop == "bailed", deferred = stop == "deferred" }
end

-- Measure before commit: past Open Cloud's 4 MiB cap the whole task is lost.
local function commitEntry(run: Run, result: ResultEntry): boolean
	local measured = ResultBudget.measure(result)
	if not ResultBudget.fits(run.budget, measured) then
		return false
	end

	publishEntry(run, result)
	table.insert(run.results, result)
	ResultBudget.add(run.budget, measured)
	return true
end

export type FanOut = (entries: { EntryPayload }) -> { ResultEntry }

-- The CLI sends entries grouped by package.
local function packageBatches(entries: { EntryPayload }): { { EntryPayload } }
	local batches: { { EntryPayload } } = {}
	local current: { EntryPayload }? = nil
	for _, entry in entries do
		if current == nil or current[1].pkg ~= entry.pkg then
			current = {}
			table.insert(batches, current :: { EntryPayload })
		end

		table.insert(current :: { EntryPayload }, entry)
	end

	return batches
end

local function runPackage(entries: { EntryPayload }, fanOut: FanOut): { ResultEntry }
	local t0 = os.clock()
	local stopCapture = GameOutputCapture.start()
	local stageOk, stageErr = pcall(Materializer.materialize, entries[1].pkg)

	local results: { ResultEntry } = {}
	if stageOk then
		results = fanOut(entries)
	else
		local elapsedMs = math.floor((os.clock() - t0) * 1000)
		for _, entry in entries do
			table.insert(results, stageFailure(entry, stageErr, elapsedMs))
		end
	end

	results[1].gameOutput = stopCapture()
	return results
end

local function runFannedOut(payload: Payload, fanOut: FanOut): ({ ResultEntry }, RunOutcome)
	local run = newRun(payload, Bail.new({ enabled = payload.bail }))
	local stop: StopReason? = nil

	for _, entries in packageBatches(payload.entries) do
		stop = stopReason(run)
		if stop ~= nil then
			break
		end

		local results = runPackage(entries, fanOut)
		pcall(Materializer.reset)

		for _, result in results do
			if not commitEntry(run, result) then
				stop = "deferred"
				break
			end
		end

		if stop ~= nil then
			break
		end
	end

	return run.results, toOutcome(stop)
end

local module = {}

function module.largestPackageSize(entries: { EntryPayload }): number
	local largest = 0
	for _, batch in packageBatches(entries) do
		largest = math.max(largest, #batch)
	end

	return largest
end

function module.runStagedEntry(callingScript: LuaSourceContainer, entry: EntryPayload): ResultEntry
	return (executeEntry(callingScript, entry, { hosted = true, prevPkg = entry.pkg }))
end

function module.runEmbedded(
	callingScript: LuaSourceContainer,
	payload: Payload,
	fanOut: FanOut?
): ({ ResultEntry }, RunOutcome)
	if fanOut ~= nil then
		return runFannedOut(payload, fanOut)
	end

	local run = newRun(payload, Bail.new({ enabled = payload.bail }))
	local prevPkg: string? = nil
	local stop: StopReason? = nil

	for _, entry in payload.entries do
		stop = stopReason(run)
		if stop ~= nil then
			break
		end

		local result, stagedPkg =
			executeEntry(callingScript, entry, { hosted = false, prevPkg = prevPkg })
		prevPkg = stagedPkg

		if not commitEntry(run, result) then
			stop = "deferred"
			break
		end
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return run.results, toOutcome(stop)
end

function module.runWorkStealing(
	callingScript: LuaSourceContainer,
	payload: Payload
): ({ ResultEntry }, RunOutcome)
	local queueId = payload.queueId :: string
	local invisibility = payload.invisibilityWindowSeconds or 90

	local entryByKey: { [string]: EntryPayload } = {}
	for _, entry in payload.entries do
		entryByKey[entry.pkg .. ENTRY_KEY_SEPARATOR .. entry.project] = entry
	end

	local queue = MemoryStoreService:GetQueue(queueId, invisibility)
	local run = newRun(
		payload,
		Bail.new({
			enabled = payload.bail,
			map = resolveSignalMap(payload),
			ttlSeconds = payload.streamingTtlSeconds,
		})
	)
	local prevPkg: string? = nil
	local stop: StopReason? = nil

	while true do
		-- Before reading: an unread item stays visible to sibling tasks.
		stop = stopReason(run)
		if stop ~= nil then
			break
		end

		local readOk, items, removeId = pcall(function()
			return queue:ReadAsync(1, false, 0)
		end)

		if not readOk then
			warn("[work-stealing] ReadAsync failed: " .. tostring(items))
			break
		end

		if items == nil or #items == 0 then
			break
		end

		local item = items[1] :: QueueItem
		local key = item.pkg .. ENTRY_KEY_SEPARATOR .. item.project
		local entry = entryByKey[key]
		if entry == nil then
			retireRead(queue, removeId)
			continue
		end

		local result, stagedPkg =
			executeEntry(callingScript, entry, { hosted = false, prevPkg = prevPkg })
		prevPkg = stagedPkg

		if not commitEntry(run, result) then
			stop = "deferred"
			-- Put back before the read is retired, so a task that dies between
			-- the two leaves a duplicate, not a lost package.
			local ttl = payload.queueTtlSeconds or DEFAULT_QUEUE_TTL_SECONDS
			if requeueRead(queue, item, ttl) then
				retireRead(queue, removeId)
			end

			break
		end

		retireRead(queue, removeId)
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return run.results, toOutcome(stop)
end

return module
