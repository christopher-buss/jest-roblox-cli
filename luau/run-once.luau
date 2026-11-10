--!strict
local HttpService = game:GetService("HttpService")

local CircusStateRelease = require("./circus-state-release")
local GameOutputCapture = require("./game-output-capture")
local InfiniteYield = require("./infinite-yield")
local InstanceResolver = require("./instance-resolver")
local InterceptWriteable = require("./intercept-writeable")
local LastSeen = require("./last-seen")
local PhaseTiming = require("./phase-timing")
local ProcessCapture = require("./process-capture")
local PromiseError = require("./promise-error")
local Protocol = require("./protocol")
local RunnerError = require("./runner-error")
local RunnerResult = require("./runner-result")
local SetupTiming = require("./setup-timing")
local SnapshotPatch = require("./snapshot-patch")

type CapturedMessage = InterceptWriteable.CapturedMessage

export type Config = {
	jestPath: string?,
	projects: { string }?,
	setupFiles: { string }?,
	setupFilesAfterEnv: { string }?,
	runnerCaptureGameOutput: boolean?,
	runnerCoverage: boolean?,
	runnerJobIndex: number?,
	runnerPerTestCoverage: boolean?,
	runnerTimeoutMs: number?,
	runnerTiming: boolean?,
	[string]: any,
}

export type Progress = {
	captureInstalled: boolean?,
	phase: string,
}

export type Outcome = {
	bannerOutput: string?,
	jestOutput: string,
	timedOut: boolean,
}

export type EntryHooks = {
	capture: boolean,
	cleanUp: ((outcome: Outcome?) -> ())?,
	stage: (() -> ())?,
}

export type EntryOutcome = {
	bannerOutput: string?,
	elapsedMs: number,
	gameOutput: string?,
	jestOutput: string,
	timedOut: boolean,
}

local module = {}

local function resolvePaths(paths: { string }?): { Instance }?
	if paths == nil or #paths == 0 then
		return paths :: any
	end

	local resolved = {}
	for _, path in paths do
		table.insert(resolved, InstanceResolver.findInstance(path))
	end

	return resolved
end

local function encodeBanner(capturedMessages: { CapturedMessage }): string?
	if #capturedMessages == 0 then
		return nil
	end

	local ok, encoded = pcall(function()
		return HttpService:JSONEncode(capturedMessages)
	end)

	return if ok then encoded else nil
end

function module.run(callingScript: LuaSourceContainer, config: Config, progress: Progress): Outcome
	config = table.clone(config)
	local t0 = os.clock()
	local timingEnabled = config.runnerTiming == true
	local budgetMs = config.runnerTimeoutMs
	local runnerCoverage = config.runnerCoverage
	local runnerPerTestCoverage = config.runnerPerTestCoverage

	progress.phase = Protocol.phases.ResolveJest
	local t_findJest0 = os.clock()
	local findOk, jestModule = pcall(InstanceResolver.getJest, config)
	local t_findJest = os.clock()
	if not findOk then
		return {
			jestOutput = HttpService:JSONEncode(
				RunnerResult.fail(PromiseError.normalize(jestModule), {
					code = RunnerError.codeOf(jestModule),
					phase = progress.phase,
				})
			),
			timedOut = false,
		}
	end

	for _, key in Protocol.runner.keys do
		config[key] = nil
	end

	-- SnapshotPatch goes in before `require(Jest)` so Jest's modules capture
	-- the mock; everything after it runs inside the guard so the unpatches
	-- below always run, or the next run would save this mock as the original.
	local snapshotWrites: { [string]: string } = {}
	local t_patchSnapshot0 = os.clock()
	local patchState = SnapshotPatch.patch(jestModule, snapshotWrites)
	CircusStateRelease.patch(jestModule)
	local t_patchSnapshot = os.clock()

	local capturedMessages: { CapturedMessage } = {}
	local restoreCapture = ProcessCapture.install(jestModule, capturedMessages)
	progress.captureInstalled = restoreCapture ~= nil

	local pending: any = nil
	local lastSeen: LastSeen.Watch? = nil
	local stopScheduling: (() -> string?)? = nil
	local setupTimingState: SetupTiming.PatchState? = nil

	local ok, value, abandonCode = InfiniteYield.guard(function()
		local t_requireJest0 = os.clock()
		local Jest = (require :: any)(jestModule)
		local t_requireJest = os.clock()

		progress.phase = Protocol.phases.ResolveProjects
		local t_resolveProjects0 = os.clock()
		local projects = config.projects
		if projects == nil or #projects == 0 then
			RunnerError.raise(
				Protocol.errorCodes.NoProjects,
				"No projects configured. Set 'projects' in jest.config.ts."
			)
		end
		local projectInstances = resolvePaths(projects)
		config.projects = {}
		local t_resolveProjects = os.clock()

		local t_resolveSetupFiles0 = os.clock()
		config.setupFiles = resolvePaths(config.setupFiles) :: any
		config.setupFilesAfterEnv = resolvePaths(config.setupFilesAfterEnv) :: any
		local t_resolveSetupFiles = os.clock()

		setupTimingState = SetupTiming.patch(
			jestModule,
			config.setupFiles :: any,
			config.setupFilesAfterEnv :: any
		)

		progress.phase = Protocol.phases.Run
		stopScheduling = RunnerResult.beginScheduling(jestModule)
		lastSeen = RunnerResult.beginLastSeen(jestModule)
		local coverage = RunnerResult.beginCoverage(jestModule, {
			coverage = runnerCoverage,
			perTest = runnerPerTestCoverage,
		})


		local t_jestRunCLI0 = os.clock()
		local runOk, result = pcall(function()
			pending = Jest.runCLI(callingScript, config, projectInstances)
			return pending:expect()
		end)
		local t_jestRunCLI = os.clock()


		if not runOk then
			error(result, 0)
		end

		return HttpService:JSONEncode(RunnerResult.build(result.results, {
			coverage = coverage,
			setupSeconds = SetupTiming.getSeconds(setupTimingState),
			snapshotWrites = snapshotWrites,
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
		}))
	end, {
		abandonNote = function()
			return RunnerResult.noteAbandon(lastSeen)
		end,
		onAbandon = function()
			if pending ~= nil then
				pending:cancel()
			end
		end,
		timeoutMs = budgetMs,
	})
	local timedOut = abandonCode == Protocol.errorCodes.Timeout
	RunnerResult.finishScheduling(stopScheduling)

	if restoreCapture then
		restoreCapture()
	end

	SetupTiming.unpatch(setupTimingState)
	SnapshotPatch.unpatch(patchState)

	local jestOutput = if ok
		then value
		else HttpService:JSONEncode(RunnerResult.fail(PromiseError.normalize(value), {
			abandon = if timedOut then Protocol.abandons.Timeout else nil,
			captureInstalled = progress.captureInstalled,
			code = abandonCode or RunnerError.codeOf(value),
			phase = progress.phase,
		}))

	return {
		bannerOutput = encodeBanner(capturedMessages),
		jestOutput = jestOutput,
		timedOut = timedOut,
	}
end

function module.runEntry(
	callingScript: LuaSourceContainer,
	config: Config,
	hooks: EntryHooks
): EntryOutcome
	local t0 = os.clock()
	local progress: Progress = { phase = Protocol.phases.Staging }
	local stopCapture = if hooks.capture then GameOutputCapture.start() else nil

	local ok: boolean, value: any = true, nil
	if hooks.stage then
		ok, value = pcall(hooks.stage)
	end

	if ok then
		ok, value = pcall(module.run, callingScript, config, progress)
	end

	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	local cleanUpOk: boolean, cleanUpErr: any = true, nil
	if hooks.cleanUp then
		cleanUpOk, cleanUpErr = pcall(hooks.cleanUp, if ok then value else nil)
	end

	local gameOutput = if stopCapture then stopCapture() else nil
	if not cleanUpOk then
		warn("Runner clean-up hook threw: " .. tostring(cleanUpErr))
	end

	if ok then
		local outcome = value :: Outcome
		return {
			bannerOutput = outcome.bannerOutput,
			elapsedMs = elapsedMs,
			gameOutput = gameOutput,
			jestOutput = outcome.jestOutput,
			timedOut = outcome.timedOut,
		}
	end

	return {
		elapsedMs = elapsedMs,
		gameOutput = gameOutput,
		jestOutput = HttpService:JSONEncode(RunnerResult.fail(PromiseError.normalize(value), {
			captureInstalled = progress.captureInstalled,
			phase = progress.phase,
		})),
		timedOut = false,
	}
end

return module
