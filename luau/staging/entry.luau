--!strict
local HttpService = game:GetService("HttpService")
local MemoryStoreService = game:GetService("MemoryStoreService")

local InstanceResolver = require("../instance-resolver")
local SnapshotPatch = require("../snapshot-patch")
local Materializer = require("./materializer")

type SnapshotWrites = { [string]: string }

type EntryPayload = {
	pkg: string,
	project: string,
	config: {
		jestPath: string?,
		projects: { string }?,
		setupFiles: { string }?,
		setupFilesAfterEnv: { string }?,
		_coverage: boolean?,
		[string]: any,
	},
}

type Payload = {
	entries: { EntryPayload },
	queueId: string?,
	invisibilityWindowSeconds: number?,
	sortedMapId: string?,
	streamingTtlSeconds: number?,
}

type QueueItem = {
	pkg: string,
	project: string,
}

type ResultEntry = {
	pkg: string,
	project: string,
	elapsedMs: number,
	jestOutput: string,
	snapshotWrites: SnapshotWrites?,
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

type JestResultPayload = {
	success: boolean,
	value: any?,
	err: any?,
	_coverage: { [string]: any }?,
}

local function resolveSetupPaths(paths: { string }?): { Instance }?
	if paths == nil or #paths == 0 then
		return paths :: any
	end

	local resolved = {}
	for _, setupPath in paths do
		table.insert(resolved, InstanceResolver.findInstance(setupPath))
	end

	return resolved
end

local function runEntry(entry: EntryPayload): (string, SnapshotWrites?)
	local JestModule = InstanceResolver.getJest(entry.config)

	-- Patch BEFORE require(Jest) so the snapshot mock is in place when
	-- Jest's internal modules capture their FileSystemService reference.
	-- Patch/unpatch per-entry isolates state across packages: SnapshotPatch
	-- saves the live getDataModelService each call, so re-patching without
	-- unpatch would freeze the previous mock as the restoration target.
	local snapshotWrites: SnapshotWrites = {}
	local patchState = SnapshotPatch.patch(JestModule, snapshotWrites)

	-- ALL post-patch work (require, project/setup resolution, runCLI) must
	-- be inside this pcall so SnapshotPatch.unpatch always runs. If require
	-- or instance resolution threw outside the pcall, the patched mock
	-- would persist on shared RobloxShared/JestRuntime modules and the
	-- next package's patch would save the stale mock as "original",
	-- causing cross-package contamination.
	local ok, jestResultOrError = pcall(function()
		local Jest = (require :: any)(JestModule)

		local projectInstances = {}
		if entry.config.projects then
			for _, projectPath in entry.config.projects do
				table.insert(projectInstances, InstanceResolver.findInstance(projectPath))
			end
		end
		entry.config.projects = {}

		-- Resolve setupFiles / setupFilesAfterEnv from DataModel-path
		-- strings to ModuleScript Instances. Jest expects Instances;
		-- without this the run crashes when setup files are configured
		-- at the package level.
		entry.config.setupFiles = resolveSetupPaths(entry.config.setupFiles) :: any
		entry.config.setupFilesAfterEnv = resolveSetupPaths(entry.config.setupFilesAfterEnv) :: any

		local coverageEnabled = entry.config._coverage == true
		if coverageEnabled then
			-- Per-package isolation: reset the global probe sink
			-- immediately before Jest.runCLI so the captured map only
			-- contains hits from this package's instrumented sources.
			_G.__jest_roblox_cov = {}
			entry.config._coverage = nil :: any
		end

		local result = Jest.runCLI(script, entry.config, projectInstances):expect()

		local payload: JestResultPayload = {
			success = true,
			value = result.results or result,
		}
		if coverageEnabled then
			payload._coverage = _G.__jest_roblox_cov
		end

		return HttpService:JSONEncode(payload)
	end)

	SnapshotPatch.unpatch(patchState)

	if not ok then
		error(jestResultOrError, 0)
	end

	local capturedWrites: SnapshotWrites? = if next(snapshotWrites) then snapshotWrites else nil

	return jestResultOrError, capturedWrites
end

local function buildSummary(result: ResultEntry): StreamingSummary
	-- Default to a "failed to run" shape; if jestOutput parses as the
	-- materializer's envelope we'll fill in the real counts.
	--
	-- Edge case: a JSONDecode failure or unexpected inner shape leaves the
	-- defaults intact, which streams as "▶ <pkg>  0 tests" — visually
	-- indistinguishable from a package that legitimately ran zero tests.
	-- runEntry wraps Jest.runCLI in pcall and encodes ALL Jest-level
	-- failures as { success = false, err = ... }, so this branch is only
	-- reached when the captured jestOutput itself is malformed JSON.
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

local function streamResult(result: ResultEntry, sortedMapId: string?, ttlSeconds: number?)
	if sortedMapId == nil or sortedMapId == "" then
		return
	end

	-- Slim payload: SortedMap items cap at 32 KB and a single package's
	-- jestOutput JSON already pushes that limit. Streaming only needs the
	-- summary fields to render a one-line progress message; the CLI keeps
	-- the full Jest result via the task envelope returned at task end.
	local summary = buildSummary(result)
	pcall(function()
		local map = MemoryStoreService:GetSortedMap(sortedMapId)
		local ttl = ttlSeconds or 600
		map:SetAsync(result.pkg .. "::" .. result.project, summary, ttl)
	end)
end

local function executeEntry(
	entry: EntryPayload,
	prevPkg: string?,
	sortedMapId: string?,
	streamingTtlSeconds: number?
): (ResultEntry, string)
	if entry.pkg ~= prevPkg then
		if prevPkg ~= nil then
			Materializer.reset()
		end
		Materializer.materialize(entry.pkg)
	end

	local t0 = os.clock()
	local ok, jestOrError, snapshotWrites = pcall(runEntry, entry)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	local result: ResultEntry
	if ok then
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = jestOrError,
			snapshotWrites = snapshotWrites,
		}
	else
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = tostring(jestOrError),
			}),
		}
	end

	-- Publish the entry immediately so the CLI can stream this package's
	-- output without waiting for the whole task to finish. Best-effort
	-- (pcall): if the SortedMap write fails the entry still lands in the
	-- envelope returned at task end, so streaming failure degrades to the
	-- existing batched behavior rather than losing the result.
	streamResult(result, sortedMapId, streamingTtlSeconds)

	return result, entry.pkg
end

local function runEmbedded(payload: Payload): { ResultEntry }
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil

	for _, entry in payload.entries do
		local result, pkg = executeEntry(entry, prevPkg, payload.sortedMapId, payload.streamingTtlSeconds)
		table.insert(results, result)
		prevPkg = pkg
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results
end

local function runWorkStealing(payload: Payload): { ResultEntry }
	local queueId = payload.queueId :: string
	local invisibility = payload.invisibilityWindowSeconds or 90

	local entryByKey: { [string]: EntryPayload } = {}
	for _, entry in payload.entries do
		entryByKey[entry.pkg .. "::" .. entry.project] = entry
	end

	local queue = MemoryStoreService:GetQueue(queueId, invisibility)
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil

	while true do
		-- waitTimeout=0: poll non-blocking. Invisibility is already set at
		-- GetQueue time above; using the full window here would stall the
		-- loop for ~invisibility seconds on the final empty read, adding
		-- that as tail latency across every parallel worker.
		local readOk, items, removeId = pcall(function()
			return queue:ReadAsync(1, false, 0)
		end)

		if not readOk then
			-- Surface the transient API error in game output instead of
			-- silently breaking; the outer "no entries for N packages"
			-- message wouldn't otherwise hint at the cause.
			warn("[work-stealing] ReadAsync failed: " .. tostring(items))
			break
		end

		if items == nil or #items == 0 then
			break
		end

		local item = items[1] :: QueueItem
		local key = item.pkg .. "::" .. item.project
		local entry = entryByKey[key]
		if entry == nil then
			-- Foreign / stale queue item — discard and keep popping.
			pcall(function()
				queue:RemoveAsync(removeId)
			end)
			continue
		end

		local result, pkg = executeEntry(entry, prevPkg, payload.sortedMapId, payload.streamingTtlSeconds)
		table.insert(results, result)
		prevPkg = pkg

		pcall(function()
			queue:RemoveAsync(removeId)
		end)
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results
end

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local results: { ResultEntry }
if payload.queueId ~= nil and payload.queueId ~= "" then
	results = runWorkStealing(payload)
else
	results = runEmbedded(payload)
end

local gameOutputs = {}
for _ = 1, #results do
	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({ entries = results }), table.concat(gameOutputs, "")
