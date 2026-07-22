--!strict
-- Single-process workspace runner: clone each package from the staged
-- mega-place's `ServerStorage.__pkg_stage`, run Jest, reset, repeat. Shared by
-- two drivers: the OCALE task script (`staging/entry.luau`, which adds the
-- MemoryStore work-stealing variant) and the Studio plugin's Run-mode runner
-- (`plugin/src/test-in-run-mode.server.luau`, single-process only). Both pass
-- their own calling script so `Jest.runCLI` resolves against the live DataModel.
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local MemoryStoreService = game:GetService("MemoryStoreService")

local InstanceResolver = require("../instance-resolver")
local InterceptWriteable = require("../intercept-writeable")
local Materializer = require("./materializer")
local PhaseTiming = require("../phase-timing")
local PromiseError = require("../promise-error")
local SnapshotPatch = require("../snapshot-patch")

type CapturedMessage = InterceptWriteable.CapturedMessage

type SnapshotWrites = { [string]: string }

export type EntryPayload = {
	pkg: string,
	project: string,
	config: {
		jestPath: string?,
		projects: { string }?,
		setupFiles: { string }?,
		setupFilesAfterEnv: { string }?,
		_coverage: boolean?,
		_timing: boolean?,
		[string]: any,
	},
}

export type Payload = {
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

export type ResultEntry = {
	pkg: string,
	project: string,
	elapsedMs: number,
	jestOutput: string,
	snapshotWrites: SnapshotWrites?,
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

type JestResultPayload = {
	success: boolean,
	value: any?,
	err: any?,
	_coverage: { [string]: any }?,
	_timing: { [string]: number }?,
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

-- Returns: (jestSuccess, jestOutputOrErrorMessage, snapshotWrites, gameOutput, bannerOutput).
-- `jestSuccess=false` means Jest itself rejected; `jestOutputOrErrorMessage`
-- carries the normalized cause string in that case, otherwise the encoded
-- success envelope.
--
-- `gameOutput` is the JSON-encoded LogService.MessageOut dump for the entry
-- (everything Studio's Output would show — native print/warn, engine
-- warnings, Jest stdout). Surfaced to users via `--gameOutput <path>`.
--
-- `bannerOutput` is the narrower InterceptWriteable capture of Jest's
-- own process.stdout/stderr writes, used by the CLI error banner to
-- surface exit-time messages like "No tests found, exiting with code 1".
local function runEntry(
	callingScript: LuaSourceContainer,
	entry: EntryPayload
): (boolean, string, SnapshotWrites?, string?, string?)
	local t0 = os.clock()
	local timingEnabled = entry.config._timing == true

	local t_findJest0 = os.clock()
	local JestModule = InstanceResolver.getJest(entry.config)
	local t_findJest = os.clock()

	-- Per-entry Game Output capture. Connected before SnapshotPatch.patch
	-- so any patch-time warning (e.g. RobloxShared shape changes) lands in
	-- the dump. Disconnected last during teardown, after restoreStdout/
	-- restoreStderr and SnapshotPatch.unpatch, to catch late warns that
	-- fire as Promise:expect resumes the coroutine.
	local logMessages: { CapturedMessage } = {}
	local logConnection = LogService.MessageOut:Connect(
		function(message: string, messageType: Enum.MessageType)
			table.insert(logMessages, {
				message = message,
				messageType = messageType.Value,
				timestamp = os.clock(),
			})
		end
	)

	-- Patch BEFORE require(Jest) so the snapshot mock is in place when
	-- Jest's internal modules capture their FileSystemService reference.
	-- Patch/unpatch per-entry isolates state across packages: SnapshotPatch
	-- saves the live getDataModelService each call, so re-patching without
	-- unpatch would freeze the previous mock as the restoration target.
	local snapshotWrites: SnapshotWrites = {}
	local t_patchSnapshot0 = os.clock()
	local patchState = SnapshotPatch.patch(JestModule, snapshotWrites)
	local t_patchSnapshot = os.clock()

	-- Intercept Jest's stdout/stderr around runCLI so per-pkg failure messages
	-- (e.g. "No tests found, exiting with code 1") are captured into the
	-- BANNER OUTPUT buffer. Single-package mode (runner.luau) does the same.
	local capturedMessages: { CapturedMessage } = {}
	local restoreStdout: (() -> ())?
	local restoreStderr: (() -> ())?
	pcall(function()
		local nodeModules = JestModule.Parent.Parent.Parent :: any
		local RobloxShared = (require :: any)(nodeModules["@rbxts-js"].RobloxShared)
		local process = RobloxShared.nodeUtils.process

		restoreStdout = InterceptWriteable.intercept(process.stdout, capturedMessages, 0)
		restoreStderr = InterceptWriteable.intercept(process.stderr, capturedMessages, 1)
	end)

	-- ALL post-patch work (require, project/setup resolution, runCLI) must
	-- be inside this pcall so SnapshotPatch.unpatch always runs. If require
	-- or instance resolution threw outside the pcall, the patched mock
	-- would persist on shared RobloxShared/JestRuntime modules and the
	-- next package's patch would save the stale mock as "original",
	-- causing cross-package contamination.
	local ok, jestResultOrError = pcall(function()
		local t_requireJest0 = os.clock()
		local Jest = (require :: any)(JestModule)
		local t_requireJest = os.clock()

		local t_resolveProjects0 = os.clock()
		local projectInstances = {}
		if entry.config.projects then
			for _, projectPath in entry.config.projects do
				table.insert(projectInstances, InstanceResolver.findInstance(projectPath))
			end
		end
		entry.config.projects = {}
		local t_resolveProjects = os.clock()

		-- Resolve setupFiles / setupFilesAfterEnv from DataModel-path
		-- strings to ModuleScript Instances. Jest expects Instances;
		-- without this the run crashes when setup files are configured
		-- at the package level.
		local t_resolveSetupFiles0 = os.clock()
		entry.config.setupFiles = resolveSetupPaths(entry.config.setupFiles) :: any
		entry.config.setupFilesAfterEnv = resolveSetupPaths(entry.config.setupFilesAfterEnv) :: any
		local t_resolveSetupFiles = os.clock()

		local coverageEnabled = entry.config._coverage == true
		if coverageEnabled then
			-- Per-package isolation: reset the global probe sink
			-- immediately before Jest.runCLI so the captured map only
			-- contains hits from this package's instrumented sources.
			_G.__jest_roblox_cov = {}
			entry.config._coverage = nil :: any
		end

		-- Strip before Jest.runCLI, mirroring runner.luau — per-entry config
		-- table, so this only affects this entry, not siblings in the batch.
		entry.config._timing = nil :: any

		local t_jestRunCLI0 = os.clock()
		local result = Jest.runCLI(callingScript, entry.config, projectInstances):expect()
		local t_jestRunCLI = os.clock()

		local payload: JestResultPayload = {
			success = true,
			value = result.results or result,
		}
		if coverageEnabled then
			payload._coverage = _G.__jest_roblox_cov
		end

		payload._timing = PhaseTiming.build(timingEnabled, {
			{ name = "findJest", seconds = t_findJest - t_findJest0 },
			{ name = "patchSnapshot", seconds = t_patchSnapshot - t_patchSnapshot0 },
			{ name = "requireJest", seconds = t_requireJest - t_requireJest0 },
			{ name = "resolveProjects", seconds = t_resolveProjects - t_resolveProjects0 },
			{ name = "resolveSetupFiles", seconds = t_resolveSetupFiles - t_resolveSetupFiles0 },
			{ name = "jestRunCLI", seconds = t_jestRunCLI - t_jestRunCLI0 },
			{ name = "total", seconds = os.clock() - t0 },
		})

		return HttpService:JSONEncode(payload)
	end)

	if restoreStdout then
		restoreStdout()
	end
	if restoreStderr then
		restoreStderr()
	end

	SnapshotPatch.unpatch(patchState)

	-- Disconnect MessageOut last so any teardown-time warns still land in
	-- gameOutput.
	logConnection:Disconnect()

	local gameOutput: string?
	if #logMessages > 0 then
		local encodeOk, encoded = pcall(function()
			return HttpService:JSONEncode(logMessages)
		end)
		if encodeOk then
			gameOutput = encoded :: string
		end
	end

	local bannerOutput: string?
	if #capturedMessages > 0 then
		local encodeOk, encoded = pcall(function()
			return HttpService:JSONEncode(capturedMessages)
		end)
		if encodeOk then
			bannerOutput = encoded :: string
		end
	end

	local capturedWrites: SnapshotWrites? = if next(snapshotWrites) then snapshotWrites else nil

	if not ok then
		return false, PromiseError.normalize(jestResultOrError), nil, gameOutput, bannerOutput
	end

	return true, jestResultOrError, capturedWrites, gameOutput, bannerOutput
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
	callingScript: LuaSourceContainer,
	entry: EntryPayload,
	prevPkg: string?,
	sortedMapId: string?,
	streamingTtlSeconds: number?
): (ResultEntry, string)
	local t0 = os.clock()

	-- Wrap the staging hand-off so a missing/torn-down `__pkg_stage` (or any
	-- materialize-side assertion) surfaces as a per-pkg envelope failure
	-- instead of escaping as `TaskScript:NNN: ...` and aborting the whole
	-- task script.
	local stageOk, stageErr = pcall(function()
		if entry.pkg ~= prevPkg then
			if prevPkg ~= nil then
				Materializer.reset()
			end
			Materializer.materialize(entry.pkg)
		end
	end)

	if not stageOk then
		local elapsedMs = math.floor((os.clock() - t0) * 1000)
		local result: ResultEntry = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = PromiseError.normalize(stageErr),
			}),
		}
		streamResult(result, sortedMapId, streamingTtlSeconds)
		return result, entry.pkg
	end

	local pcallOk, jestSuccess, primary, snapshotWrites, gameOutput, bannerOutput =
		pcall(runEntry, callingScript, entry)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	local result: ResultEntry
	if not pcallOk then
		-- runEntry itself errored (e.g. InstanceResolver/getJest failure
		-- before interception was installed). `jestSuccess` here holds the
		-- raw error value pcall returned in slot 2 — normalize it the same
		-- way the Jest-rejection path does.
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = PromiseError.normalize(jestSuccess),
			}),
		}
	elseif jestSuccess then
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = primary,
			snapshotWrites = snapshotWrites,
			gameOutput = gameOutput,
			bannerOutput = bannerOutput,
		}
	else
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = primary,
			}),
			gameOutput = gameOutput,
			bannerOutput = bannerOutput,
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

local module = {}

function module.runEmbedded(callingScript: LuaSourceContainer, payload: Payload): { ResultEntry }
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil

	for _, entry in payload.entries do
		local result, pkg = executeEntry(
			callingScript,
			entry,
			prevPkg,
			payload.sortedMapId,
			payload.streamingTtlSeconds
		)
		table.insert(results, result)
		prevPkg = pkg
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results
end

function module.runWorkStealing(
	callingScript: LuaSourceContainer,
	payload: Payload
): { ResultEntry }
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

		local result, pkg = executeEntry(
			callingScript,
			entry,
			prevPkg,
			payload.sortedMapId,
			payload.streamingTtlSeconds
		)
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

return module
