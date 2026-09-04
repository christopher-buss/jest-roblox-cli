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
local InfiniteYield = require("../infinite-yield")
local InstanceResolver = require("../instance-resolver")
local InterceptWriteable = require("../intercept-writeable")
local Materializer = require("./materializer")
local PhaseTiming = require("../phase-timing")
local PromiseError = require("../promise-error")
local ResultBudget = require("./result-budget")
local RunnerResult = require("../runner-result")
local SetupTiming = require("../setup-timing")
local SnapshotPatch = require("../snapshot-patch")
local TestProgress = require("../test-progress")

type CapturedMessage = InterceptWriteable.CapturedMessage

type SnapshotWrites = { [string]: string }

-- What `payload.queueTtlSeconds` falls back to, matching the CLI's own default
-- in `src/memory-store/work-stealing.ts`.
local DEFAULT_QUEUE_TTL_SECONDS = 600

-- Priority a re-queued item goes back at, above the 0 the CLI seeds with, so
-- the next read takes it ahead of everything still queued. Put back at the
-- seeded priority it would go behind them all, and the worker that finally
-- reached it would be carrying results again and would drop it a second time.
--
-- This puts the item in front, not in front of an empty worker: a sibling
-- mid-drain reads it first too, and drops it again. That costs another run of
-- the package and another deferral, and the replacement the deferral earns does
-- meet it empty, so the item still lands — but a run whose siblings keep
-- winning the race can spend its whole launch budget on it.
local REQUEUE_PRIORITY = 1

-- How many times a put-back is tried before the worker gives up, and the wait
-- before the second try — each try after that waits twice as long as the one
-- before. MemoryStore refuses a write when the queue is over its request
-- quota, which clears on the order of a second, so a short backoff is what the
-- retries are for; a longer one would only sit on the task's deadline.
local REQUEUE_ATTEMPTS = 3
local REQUEUE_BACKOFF_SECONDS = 0.5

export type EntryPayload = {
	pkg: string,
	project: string,
	config: {
		jestPath: string?,
		projects: { string }?,
		setupFiles: { string }?,
		setupFilesAfterEnv: { string }?,
		runnerCoverage: boolean?,
		runnerPerTestCoverage: boolean?,
		runnerTimeoutMs: number?,
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
	-- TTL the CLI seeded the queue items with, named again when this task puts
	-- an item back. The queue reports nothing about what is left of the item's
	-- own, so a put-back restarts the TTL rather than continuing it, and an item
	-- dropped repeatedly outlives the seeded window. Absent means the default
	-- below.
	queueTtlSeconds: number?,
	-- Caps the encoded size of this task's return envelope. Absent means the
	-- module's own default. See `result-budget.luau`.
	resultBudgetBytes: number?,
	sortedMapId: string?,
	streamingTtlSeconds: number?,
	-- Per-run SortedMap the runtime heartbeats which test it reached into, so
	-- a task that never returns can still be told apart from one that hung
	-- somewhere else. Its own map, not `sortedMapId`: the CLI drains that one
	-- as results arrive, and a heartbeat is read once, after a failure.
	progress: { mapId: string, ttlSeconds: number? }?,
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

--[=[
	One task's run, as everything below the two loops sees it.

	The envelope being assembled and the two things that decide when to stop
	assembling it, in one value: they are read together by every step of taking
	a package, and both loops set them up the same way.
]=]
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

-- One publisher per task, built at the top of the loop the task drives and
-- threaded down: the key it writes under is generated once, so every entry the
-- task runs heartbeats into the same record and the host reads back one per
-- task.
local function progressPublisher(payload: Payload): TestProgress.Publish?
	local progress = payload.progress
	return if progress
		then TestProgress.sortedMapPublisher(progress.mapId, progress.ttlSeconds)
		else nil
end

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

-- Returns: (jestSuccess, jestOutputOrErrorMessage, snapshotWrites, bannerOutput,
-- timedOut).
-- `jestSuccess=false` means Jest itself rejected; `jestOutputOrErrorMessage`
-- carries the normalized cause string in that case, otherwise the encoded
-- success envelope. `timedOut` is true only for the one rejection the watchdog
-- raised itself, having spent the entry's whole budget. It stays a local
-- answer: the caller tears the stage down on it, and encodes it for the host
-- as the failure envelope's abandon reason.
--
-- `bannerOutput` is the narrower InterceptWriteable capture of Jest's
-- own process.stdout/stderr writes, used by the CLI error banner to
-- surface exit-time messages like "No tests found, exiting with code 1".
-- The wider Game Output capture lives in `executeEntry`, around this call.
local function runEntry(
	callingScript: LuaSourceContainer,
	entry: EntryPayload,
	publishProgress: TestProgress.Publish?
): (boolean, string, SnapshotWrites?, string?, boolean)
	local t0 = os.clock()
	local timingEnabled = entry.config.runnerTiming == true
	-- Read before the guarded closure strips it off the config for Jest.
	-- Absent means the host asked for no budget.
	local budgetMs = entry.config.runnerTimeoutMs

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
	-- be inside this guard so SnapshotPatch.unpatch always runs. If require
	-- or instance resolution threw outside it, the patched mock
	-- would persist on shared RobloxShared/JestRuntime modules and the
	-- next package's patch would save the stale mock as "original",
	-- causing cross-package contamination.
	--
	-- The guard pcalls what it is given, and ends a package that parks on a
	-- `WaitForChild` the stage cannot satisfy — one package failing rather than
	-- the whole task hitting its deadline. Cancelling the run is what frees the
	-- parked thread; see the guard on why closing this closure is not enough.
	local pending: any = nil
	local ok, jestResultOrError, timedOut = InfiniteYield.guard(function()
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

		-- Per-package isolation: the shared helper resets the global probe
		-- sink here, immediately before Jest.runCLI, so the captured map only
		-- contains hits from this package's instrumented sources — and installs
		-- the per-test hook against this package's own jest instance.
		local coverage = RunnerResult.beginCoverage(JestModule, {
			coverage = entry.config.runnerCoverage,
			perTest = entry.config.runnerPerTestCoverage,
		})
		RunnerResult.beginProgress(JestModule, publishProgress)

		-- Strip before Jest.runCLI, mirroring runner.luau — per-entry config
		-- table, so this only affects this entry, not siblings in the batch.
		entry.config.runnerCoverage = nil :: any
		entry.config.runnerPerTestCoverage = nil :: any
		entry.config.runnerTimeoutMs = nil :: any
		entry.config.runnerTiming = nil :: any

		local t_jestRunCLI0 = os.clock()
		-- Held so the watchdog can cancel it: the thread an infinite yield
		-- parks is this promise's executor, not the one waiting on it.
		pending = Jest.runCLI(callingScript, entry.config, projectInstances)
		local result = pending:expect()
		local t_jestRunCLI = os.clock()

		-- Through the seam runner.luau assembles through too. Setup time is
		-- reported apart from the timing phases so the host subtracts it from
		-- the environment residual, as it does for a single-package run.
		--
		-- No `snapshotWrites` here, unlike runner.luau: this mode returns one
		-- envelope per package, so the writes ride on the entry itself
		-- (`ResultEntry.snapshotWrites`) and the host prefers that over the
		-- payload field. Every other dimension belongs in the call below.
		local payload = RunnerResult.build(result.results or result, {
			coverage = coverage,
			setupSeconds = SetupTiming.getSeconds(setupTimingState),
			timing = PhaseTiming.build(timingEnabled, {
				{ name = "findJest", seconds = t_findJest - t_findJest0 },
				{ name = "patchSnapshot", seconds = t_patchSnapshot - t_patchSnapshot0 },
				{ name = "requireJest", seconds = t_requireJest - t_requireJest0 },
				{ name = "resolveProjects", seconds = t_resolveProjects - t_resolveProjects0 },
				{
					name = "resolveSetupFiles",
					seconds = t_resolveSetupFiles - t_resolveSetupFiles0,
				},
				{ name = "jestRunCLI", seconds = t_jestRunCLI - t_jestRunCLI0 },
				{ name = "total", seconds = os.clock() - t0 },
			}),
		})

		return HttpService:JSONEncode(payload)
	end, {
		onAbandon = function()
			if pending ~= nil then
				pending:cancel()
			end
		end,
		timeoutMs = budgetMs,
	})

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
		return false, PromiseError.normalize(jestResultOrError), nil, bannerOutput, timedOut
	end

	return true, jestResultOrError, capturedWrites, bannerOutput, false
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
local function summarize(run: Run, result: ResultEntry): StreamingSummary?
	local sortedMapId = run.payload.sortedMapId
	local isStreaming = sortedMapId ~= nil and sortedMapId ~= ""
	if not isStreaming and not Bail.isEnabled(run.bail) then
		return nil
	end

	return buildSummary(result)
end

-- Publish the entry and record how it went, in that order: streaming is
-- best-effort, and a package that fails must reach the CLI before the task
-- that ran it stops. A package whose output will not decode counts as failed —
-- `buildSummary` defaults that way, and stopping on an unreadable result is
-- the same call `--bail` makes on a readable failure.
--
-- Called per entry rather than per task, so the CLI streams a package's output
-- without waiting for the ones after it. If the SortedMap write fails the entry
-- still lands in the envelope returned at task end, so streaming failure
-- degrades to batched output rather than a lost result.
local function publishEntry(run: Run, result: ResultEntry)
	local summary = summarize(run, result)
	if summary ~= nil then
		local payload = run.payload
		streamResult(summary, payload.sortedMapId, payload.streamingTtlSeconds)
		Bail.observe(run.bail, summary.success)
	end
end

--[=[
	Run one entry and report it, alongside the package left staged afterwards.

	The caller passes that second value back as `prevPkg` on the next entry, so
	the rule for what is still in the DataModel lives here — beside the teardown
	that decides it — rather than in each of the two dispatch loops.
]=]
local function executeEntry(
	callingScript: LuaSourceContainer,
	entry: EntryPayload,
	prevPkg: string?,
	publishProgress: TestProgress.Publish?
): (ResultEntry, string?)
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
			jestOutput = HttpService:JSONEncode(
				RunnerResult.fail(PromiseError.normalize(stageErr))
			),
			gameOutput = stopCapture(),
		}
		return result, entry.pkg
	end

	local pcallOk, jestSuccess, primary, snapshotWrites, bannerOutput, timedOut =
		pcall(runEntry, callingScript, entry, publishProgress)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	-- Torn down here rather than at the next entry's materialize: the run this
	-- package left behind was abandoned, not ended, and whatever its scripts do
	-- on Destroy belongs inside its own capture window instead of landing on
	-- the package that happens to run next. Nothing of it is left staged, which
	-- is what this function reports back so the next entry stages afresh.
	local abandoned = timedOut == true
	if abandoned then
		pcall(Materializer.reset)
	end

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
			jestOutput = HttpService:JSONEncode(
				RunnerResult.fail(PromiseError.normalize(jestSuccess))
			),
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
			jestOutput = HttpService:JSONEncode(
				RunnerResult.fail(primary, { abandon = if abandoned then "timeout" else nil })
			),
			gameOutput = gameOutput,
			bannerOutput = bannerOutput,
		}
	end

	return result, if abandoned then nil else entry.pkg
end

-- Take the item this worker read off the queue for good. Best-effort: a remove
-- that fails leaves the item to reappear on its invisibility window, where a
-- sibling runs it again and the CLI folds the duplicate into one result.
local function retireRead(queue: any, removeId: any)
	pcall(function()
		queue:RemoveAsync(removeId)
	end)
end

--[=[
	Put a read item back on the queue, retrying a refusal.

	Returns whether it landed. It has to: an item that never lands stays
	invisible for the rest of its window, and the replacement task the deferral
	asks for reads non-blocking, so it boots well inside that window and finds
	nothing. What is left is a sibling still draining when the window expires —
	and a worker that is the last one running has no sibling, so the package is
	lost rather than late. Hence the retries: a refusal is normally the request
	quota, which the next attempt clears.
]=]
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
local function stopReason(run: Run): StopReason?
	if Bail.shouldStop(run.bail) then
		return "bailed"
	end

	if ResultBudget.shouldStop(run.budget) then
		return "deferred"
	end

	return nil
end

local function toOutcome(stop: StopReason?): RunOutcome
	return { bailed = stop == "bailed", deferred = stop == "deferred" }
end

--[=[
	Put a finished entry in the envelope, or refuse it.

	Measured before it is committed, because measuring afterwards decides
	nothing: the entry is already in the results by then, and the envelope goes
	out over Open Cloud's 4 MiB limit. Open Cloud rejects the whole task, so
	every package it ran is lost, not just the one that tipped it over.

	A refused entry is dropped rather than returned, and its caller defers so
	another task runs it again. That wastes the work the entry already did,
	which is the price of a cap that holds. Nothing is published for it either:
	it is going to be reported by the task that reruns it, and a package the CLI
	has already heard about would print twice and could trip `--bail` on a
	failure no envelope carries.

	The whole entry goes, rather than the `gameOutput` and coverage payload that
	usually push it over. Shedding those would keep the run cheaper, but it
	returns a package whose coverage silently covers less than it ran — a wrong
	report where a rerun costs only time.
]=]
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
	local run: Run = {
		-- No queue on this path, so no siblings to tell: the trip stays local.
		bail = Bail.new({ enabled = payload.bail }),
		budget = ResultBudget.new(payload.resultBudgetBytes),
		payload = payload,
		results = {},
	}
	local prevPkg: string? = nil
	local publishProgress = progressPublisher(payload)
	local stop: StopReason? = nil

	for _, entry in payload.entries do
		stop = stopReason(run)
		if stop ~= nil then
			break
		end

		local result, stagedPkg = executeEntry(callingScript, entry, prevPkg, publishProgress)
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
	local run: Run = {
		-- Siblings drain the same queue, and Open Cloud cannot cancel a running
		-- task, so the trip travels through the results map they all share.
		bail = Bail.new({
			enabled = payload.bail,
			map = resolveSignalMap(payload),
			ttlSeconds = payload.streamingTtlSeconds,
		}),
		budget = ResultBudget.new(payload.resultBudgetBytes),
		payload = payload,
		results = {},
	}
	local prevPkg: string? = nil
	local publishProgress = progressPublisher(payload)
	local stop: StopReason? = nil

	while true do
		-- Asked before reading, not after running: an item this worker never
		-- reads stays visible in the queue, so a sibling task picks it up
		-- immediately instead of waiting out the invisibility window.
		stop = stopReason(run)
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
			retireRead(queue, removeId)
			continue
		end

		local result, stagedPkg = executeEntry(callingScript, entry, prevPkg, publishProgress)
		prevPkg = stagedPkg

		if not commitEntry(run, result) then
			stop = "deferred"
			-- A dropped entry has to run again, and left as this worker read
			-- it the item stays invisible for the rest of the window — the
			-- replacement task the deferral asks for boots well inside that
			-- and would read an empty queue. Put back before the read is
			-- retired, so a task that dies between the two leaves a duplicate
			-- the CLI folds into one result rather than losing the package.
			-- A put-back refused every attempt leaves the read standing
			-- instead: the item then comes back on its invisibility window,
			-- which only a sibling still draining is there to read, and that is
			-- more than retiring the read would leave.
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
