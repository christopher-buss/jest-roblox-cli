--!strict
-- Single-process workspace runner: clone each package from the staged
-- mega-place's `ServerStorage.__pkg_stage`, run Jest, reset, repeat. Shared by
-- two drivers: the OCALE task script (`staging/entry.luau`, which adds the
-- MemoryStore work-stealing variant) and the Studio plugin's Run-mode runner
-- (`plugin/src/test-in-run-mode.server.luau`, single-process only). Both pass
-- their own calling script so `Jest.runCLI` resolves against the live DataModel.
local HttpService = game:GetService("HttpService")
local MemoryStoreService = game:GetService("MemoryStoreService")

local Bail = require("./bail")
local GameOutputCapture = require("../game-output-capture")
local InstanceResolver = require("../instance-resolver")
local InterceptWriteable = require("../intercept-writeable")
local Materializer = require("./materializer")
local PhaseTiming = require("../phase-timing")
local PromiseError = require("../promise-error")
local ResultBudget = require("./result-budget")
local SetupTiming = require("../setup-timing")
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
		runnerCoverage: boolean?,
		runnerTiming: boolean?,
		[string]: any,
	},
}

export type Payload = {
	entries: { EntryPayload },
	-- Fail fast: stop taking packages once one of them fails. See bail.luau.
	bail: boolean?,
	-- Per-run SortedMap the parallel wave broadcasts a bail through. Its own
	-- map, not `sortedMapId`: the CLI never reads it, and a run that bails
	-- without streaming should not publish results nobody drains.
	bailMapId: string?,
	queueId: string?,
	invisibilityWindowSeconds: number?,
	-- Caps the encoded size of this task's return envelope. Absent means the
	-- module's own default. See `result-budget.luau`.
	resultBudgetBytes: number?,
	sortedMapId: string?,
	streamingTtlSeconds: number?,
}

--[=[
	Why a run stopped, for the CLI to answer.

	`deferred` means work is left and another task should collect it;
	`bailed` means work is left on purpose and no task should.
]=]
export type RunOutcome = {
	bailed: boolean,
	deferred: boolean,
}

-- Why a loop stopped with work left, before it is widened to the wire's pair of
-- booleans. `nil` means it stopped because there was nothing left to take.
type StopReason = "bailed" | "deferred"

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

-- Fields this runner adds alongside Jest's own result. They sit under one
-- `runner` key so the TS side tells them from Jest's by structure — see
-- `runner.luau`, which nests the same way with more fields.
type RunnerFields = {
	coverage: { [string]: any }?,
	setup: number?,
	timing: { [string]: number }?,
}

type JestResultPayload = {
	success: boolean,
	value: any?,
	err: any?,
	runner: RunnerFields?,
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

-- Returns: (jestSuccess, jestOutputOrErrorMessage, snapshotWrites, bannerOutput).
-- `jestSuccess=false` means Jest itself rejected; `jestOutputOrErrorMessage`
-- carries the normalized cause string in that case, otherwise the encoded
-- success envelope.
--
-- `bannerOutput` is the narrower InterceptWriteable capture of Jest's
-- own process.stdout/stderr writes, used by the CLI error banner to
-- surface exit-time messages like "No tests found, exiting with code 1".
-- The wider Game Output capture lives in `executeEntry`, around this call.
local function runEntry(
	callingScript: LuaSourceContainer,
	entry: EntryPayload
): (boolean, string, SnapshotWrites?, string?)
	local t0 = os.clock()
	local timingEnabled = entry.config.runnerTiming == true

	local t_findJest0 = os.clock()
	local JestModule = InstanceResolver.getJest(entry.config)
	local t_findJest = os.clock()

	-- Patch BEFORE require(Jest) so the snapshot mock is in place when
	-- Jest's internal modules capture their FileSystemService reference.
	-- Patch/unpatch per-entry isolates state across packages: SnapshotPatch
	-- saves the live getDataModelService each call, so re-patching without
	-- unpatch would freeze the previous mock as the restoration target.
	local snapshotWrites: SnapshotWrites = {}
	-- Declared out here for the same reason `patchState` is: SetupTiming swaps a
	-- method on the SHARED JestRuntime module, so the unpatch has to run on the
	-- error path too. Left patched, the next entry in the batch would keep timing
	-- against this entry's setup set.
	local setupTimingState: SetupTiming.PatchState? = nil
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

		-- After resolution, not before: the patch keys its set on the resolved
		-- ModuleScript Instances, which is what Jest requires through.
		setupTimingState = SetupTiming.patch(
			JestModule,
			entry.config.setupFiles :: any,
			entry.config.setupFilesAfterEnv :: any
		)

		local coverageEnabled = entry.config.runnerCoverage == true
		if coverageEnabled then
			-- Per-package isolation: reset the global probe sink
			-- immediately before Jest.runCLI so the captured map only
			-- contains hits from this package's instrumented sources.
			_G.__jest_roblox_cov = {}
			entry.config.runnerCoverage = nil :: any
		end

		-- Strip before Jest.runCLI, mirroring runner.luau — per-entry config
		-- table, so this only affects this entry, not siblings in the batch.
		entry.config.runnerTiming = nil :: any

		local t_jestRunCLI0 = os.clock()
		local result = Jest.runCLI(callingScript, entry.config, projectInstances):expect()
		local t_jestRunCLI = os.clock()

		local payload: JestResultPayload = {
			success = true,
			value = result.results or result,
		}

		local runner: RunnerFields = {}
		if coverageEnabled then
			runner.coverage = _G.__jest_roblox_cov
		end

		-- Reported separately so the host subtracts it from the environment
		-- residual, as it does for a single-package run.
		local setupSeconds = SetupTiming.getSeconds(setupTimingState)
		if setupSeconds > 0 then
			runner.setup = setupSeconds
		end

		runner.timing = PhaseTiming.build(timingEnabled, {
			{ name = "findJest", seconds = t_findJest - t_findJest0 },
			{ name = "patchSnapshot", seconds = t_patchSnapshot - t_patchSnapshot0 },
			{ name = "requireJest", seconds = t_requireJest - t_requireJest0 },
			{ name = "resolveProjects", seconds = t_resolveProjects - t_resolveProjects0 },
			{ name = "resolveSetupFiles", seconds = t_resolveSetupFiles - t_resolveSetupFiles0 },
			{ name = "jestRunCLI", seconds = t_jestRunCLI - t_jestRunCLI0 },
			{ name = "total", seconds = os.clock() - t0 },
		})

		-- An empty Luau table encodes as `[]`, so attach only a populated one.
		if next(runner :: any) then
			payload.runner = runner
		end

		return HttpService:JSONEncode(payload)
	end)

	if restoreStdout then
		restoreStdout()
	end
	if restoreStderr then
		restoreStderr()
	end

	SetupTiming.unpatch(setupTimingState)
	SnapshotPatch.unpatch(patchState)

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
		return false, PromiseError.normalize(jestResultOrError), nil, bannerOutput
	end

	return true, jestResultOrError, capturedWrites, bannerOutput
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

-- Slim payload: SortedMap items cap at 32 KB and a single package's jestOutput
-- JSON already pushes that limit. Streaming only needs the summary fields to
-- render a one-line progress message; the CLI keeps the full Jest result via
-- the task envelope returned at task end.
local function streamResult(summary: StreamingSummary, sortedMapId: string?, ttlSeconds: number?)
	if sortedMapId == nil or sortedMapId == "" then
		return
	end

	pcall(function()
		local map = MemoryStoreService:GetSortedMap(sortedMapId)
		local ttl = ttlSeconds or 600
		map:SetAsync(summary.pkg .. "::" .. summary.project, summary, ttl)
	end)
end

--[=[
	Summarize a finished package, but only for someone who will read it.

	`buildSummary` decodes the package's whole Jest output, which is the same
	string the return-envelope budget exists to cap — so a run with neither a
	streaming consumer nor `--bail` must not pay for it.
]=]
local function summarize(result: ResultEntry, payload: Payload, bail: Bail.State): StreamingSummary?
	local sortedMapId = payload.sortedMapId
	local isStreaming = sortedMapId ~= nil and sortedMapId ~= ""
	if not isStreaming and not Bail.isEnabled(bail) then
		return nil
	end

	return buildSummary(result)
end

-- Publish the entry and record how it went, in that order: streaming is
-- best-effort, and a package that fails must reach the CLI before the task
-- that ran it stops. A package whose output will not decode counts as failed —
-- `buildSummary` defaults that way, and stopping on an unreadable result is
-- the same call `--bail` makes on a readable failure.
local function publishEntry(result: ResultEntry, payload: Payload, bail: Bail.State): ResultEntry
	local summary = summarize(result, payload, bail)
	if summary ~= nil then
		streamResult(summary, payload.sortedMapId, payload.streamingTtlSeconds)
		Bail.observe(bail, summary.success)
	end

	return result
end

local function executeEntry(
	callingScript: LuaSourceContainer,
	entry: EntryPayload,
	prevPkg: string?,
	payload: Payload,
	bail: Bail.State
): ResultEntry
	local t0 = os.clock()
	local changingPackage = entry.pkg ~= prevPkg

	-- Wrap the staging hand-off so a missing/torn-down `__pkg_stage` (or any
	-- materialize-side assertion) surfaces as a per-pkg envelope failure
	-- instead of escaping as `TaskScript:NNN: ...` and aborting the whole
	-- task script.
	--
	-- The previous package is torn down BEFORE this entry's capture opens, so
	-- whatever its scripts say on Destroy cannot land on the package that
	-- happens to run next. Its own capture has already closed by then, so the
	-- teardown slice reaches no capture at all.
	local stageOk: boolean, stageErr: any = true, nil
	if changingPackage and prevPkg ~= nil then
		stageOk, stageErr = pcall(Materializer.reset)
	end

	-- Opened before materialize and closed after Jest's teardown, so the
	-- window covers the whole of this package's time in the live DataModel:
	-- scripts that start on parenting, patch-time warnings, the run itself,
	-- and the late warns that fire as Promise:expect resumes the coroutine.
	local stopCapture = GameOutputCapture.start()

	if stageOk and changingPackage then
		stageOk, stageErr = pcall(Materializer.materialize, entry.pkg)
	end

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
			gameOutput = stopCapture(),
		}
		return publishEntry(result, payload, bail)
	end

	local pcallOk, jestSuccess, primary, snapshotWrites, bannerOutput =
		pcall(runEntry, callingScript, entry)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)
	local gameOutput = stopCapture()

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
			gameOutput = gameOutput,
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

	-- Published immediately so the CLI can stream this package's output without
	-- waiting for the whole task to finish. Best-effort (pcall): if the
	-- SortedMap write fails the entry still lands in the envelope returned at
	-- task end, so streaming failure degrades to the existing batched behavior
	-- rather than losing the result.
	return publishEntry(result, payload, bail)
end

-- Absent on the single-task path, where there are no siblings to tell.
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

--[=[
	Why this task should take no further package, if it should not.

	Bail is asked first: a task that fills its envelope AND has bailed must
	report the bail, because a deferral asks the CLI for a replacement task and
	a bail asks it for none.
]=]
local function stopReason(bail: Bail.State, budget: ResultBudget.Tracker): StopReason?
	if Bail.shouldStop(bail) then
		return "bailed"
	end

	if ResultBudget.shouldStop(budget) then
		return "deferred"
	end

	return nil
end

local function toOutcome(stop: StopReason?): RunOutcome
	return { bailed = stop == "bailed", deferred = stop == "deferred" }
end

local module = {}

--[=[
	Walk the payload's entries in order, stopping early if the return envelope
	fills up or a package fails under `--bail`.

	Returns the entries it ran and why it stopped. There is no queue on this
	path, so the CLI answers a deferral by sending a new task carrying only the
	entries that did not run — and answers a bail by sending nothing.
]=]
function module.runEmbedded(
	callingScript: LuaSourceContainer,
	payload: Payload
): ({ ResultEntry }, RunOutcome)
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil
	local budget = ResultBudget.new(payload.resultBudgetBytes)
	-- No queue on this path, so no siblings to tell: the trip stays local.
	local bail = Bail.new({ enabled = payload.bail })
	local stop: StopReason? = nil

	for _, entry in payload.entries do
		stop = stopReason(bail, budget)
		if stop ~= nil then
			break
		end

		local result = executeEntry(callingScript, entry, prevPkg, payload, bail)
		table.insert(results, result)
		ResultBudget.add(budget, ResultBudget.measure(result))
		prevPkg = entry.pkg
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results, toOutcome(stop)
end

--[=[
	Drain the shared queue until it is empty, this task's return envelope is
	full, or a package fails under `--bail`.

	Returns the entries it ran and why it stopped. A deferral asks the CLI for
	another task to collect what this one left behind; a bail asks it for none.
]=]
function module.runWorkStealing(
	callingScript: LuaSourceContainer,
	payload: Payload
): ({ ResultEntry }, RunOutcome)
	local queueId = payload.queueId :: string
	local invisibility = payload.invisibilityWindowSeconds or 90

	local entryByKey: { [string]: EntryPayload } = {}
	for _, entry in payload.entries do
		entryByKey[entry.pkg .. "::" .. entry.project] = entry
	end

	local queue = MemoryStoreService:GetQueue(queueId, invisibility)
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil
	local budget = ResultBudget.new(payload.resultBudgetBytes)
	-- Siblings drain the same queue, and Open Cloud cannot cancel a running
	-- task, so the trip travels through the results map they all share.
	local bail = Bail.new({
		enabled = payload.bail,
		map = resolveSignalMap(payload),
		ttlSeconds = payload.streamingTtlSeconds,
	})
	local stop: StopReason? = nil

	while true do
		-- Asked before reading, not after running: an item this worker never
		-- reads stays visible in the queue, so a sibling task picks it up
		-- immediately instead of waiting out the invisibility window.
		stop = stopReason(bail, budget)
		if stop ~= nil then
			break
		end

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

		local result = executeEntry(callingScript, entry, prevPkg, payload, bail)
		table.insert(results, result)
		ResultBudget.add(budget, ResultBudget.measure(result))
		prevPkg = entry.pkg

		pcall(function()
			queue:RemoveAsync(removeId)
		end)
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results, toOutcome(stop)
end

return module
