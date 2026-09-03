--!strict
local HttpService = game:GetService("HttpService")

local GameOutputCapture = require("./game-output-capture")
local InfiniteYield = require("./infinite-yield")
local InstanceResolver = require("./instance-resolver")
local InterceptWriteable = require("./intercept-writeable")
local PhaseTiming = require("./phase-timing")
local PromiseError = require("./promise-error")
local RunnerResult = require("./runner-result")
local SetupTiming = require("./setup-timing")
local SnapshotPatch = require("./snapshot-patch")

type CapturedMessage = InterceptWriteable.CapturedMessage

type Config = {
	jestPath: string?,
	projects: { string }?,
	setupFiles: { string }?,
	setupFilesAfterEnv: { string }?,
	--[[
		Whether this config's run owns a Game Output capture. Defaults to true.
		Set false by an in-session parallel VM host, whose capture would be a
		duplicate: `LogService.MessageOut` broadcasts to every listener in the
		DataModel, so under parallel the coordinator's single batch capture
		already holds every message this one would.
	]]
	runnerCaptureGameOutput: boolean?,
	runnerCoverage: boolean?,
	runnerPerTestCoverage: boolean?,
	-- Wall-clock budget for this config's whole run. Absent means none.
	runnerTimeoutMs: number?,
	runnerTiming: boolean?,
}

local function fail(err: string)
	return {
		success = false,
		err = err,
	}
end

local module = {}

--[=[
	Run one config and return its (jestResult, gameOutput, bannerOutput,
	timedOut) quad.

	`timedOut` says the run was abandoned at `runnerTimeoutMs` rather than
	failing; `jestResult` then carries the abandon message. Workspace mode
	reports the same flag from its own runner, so the host tells the two apart
	the same way whichever mode produced the entry.
]=]
function module.run(
	callingScript: LuaSourceContainer,
	config: Config
): (string, string, string, boolean)
	local t0 = os.clock()
	local timingEnabled = config.runnerTiming
	local coverageEnabled = config.runnerCoverage
	local perTestEnabled = config.runnerPerTestCoverage

	-- Game Output capture opens at the top of the run so engine warnings
	-- during findJest/require(Jest) (broken jestPath, missing dep) also land
	-- in the user-facing `--gameOutput` dump, and stops last during teardown
	-- so late warns that fire after Promise:expect resumes the coroutine still
	-- reach it — GetLogHistory drops those, though Studio Output shows them.
	-- This runner's envelope carries a string, so an empty capture is "[]".
	--
	-- Skipped entirely when the caller owns a capture of its own: every
	-- listener sees every message, so a second capture is the same log
	-- collected, held, and JSON-encoded twice.
	local stopCapture = if config.runnerCaptureGameOutput == false
		then nil
		else GameOutputCapture.start()

	local function encodeGameOutput(): string
		return (if stopCapture then stopCapture() else nil) or "[]"
	end

	local t_findJest0 = os.clock()
	local findSuccess, findValue = pcall(InstanceResolver.getJest, config)
	local t_findJest = os.clock()

	if not findSuccess then
		return HttpService:JSONEncode(fail(findValue :: any)), encodeGameOutput(), "[]", false
	end

	local snapshotWrites: { [string]: string } = {}

	local t_patchSnapshot0 = os.clock()
	local patchState = SnapshotPatch.patch(findValue, snapshotWrites)
	local t_patchSnapshot = os.clock()

	local t_requireJest0 = os.clock()
	local Jest = (require :: any)(findValue)
	local t_requireJest = os.clock()

	-- Intercept Jest's stdout/stderr to capture output synchronously into
	-- the BANNER OUTPUT buffer. Jest writes via process.stdout/stderr
	-- (Writeable objects whose _writeFn defaults to print); wrapping
	-- _writeFn captures messages like "No tests found" that are printed
	-- just before exit(1) throws. Distinct from the LogService-sourced
	-- Game Output above: this narrower buffer is what the CLI's error
	-- banner reads on Luau errors (see cli.ts:formatLuauErrorBanner).
	local capturedMessages: { CapturedMessage } = {}
	local restoreStdout: (() -> ())?
	local restoreStderr: (() -> ())?

	local interceptOk = pcall(function()
		local nodeModules = findValue.Parent.Parent.Parent :: any
		local RobloxShared = (require :: any)(nodeModules["@rbxts-js"].RobloxShared)
		local process = RobloxShared.nodeUtils.process

		restoreStdout = InterceptWriteable.intercept(process.stdout, capturedMessages, 0)
		restoreStderr = InterceptWriteable.intercept(process.stderr, capturedMessages, 1)
	end)

	if not interceptOk then
		restoreStdout = nil
		restoreStderr = nil
	end

	local pending: any = nil

	local function runTests()
		local t_resolveProjects0 = os.clock()
		local projects = {}

		assert(
			config.projects and #config.projects > 0,
			"No projects configured. Set 'projects' in jest.config.ts."
		)

		for _, projectPath in config.projects do
			table.insert(projects, InstanceResolver.findInstance(projectPath))
		end

		config.projects = {}
		local t_resolveProjects = os.clock()

		local t_resolveSetupFiles0 = os.clock()
		if config.setupFiles and #config.setupFiles > 0 then
			local resolved = {}

			for _, setupPath in config.setupFiles do
				table.insert(resolved, InstanceResolver.findInstance(setupPath))
			end

			config.setupFiles = resolved :: any
		end
		if config.setupFilesAfterEnv and #config.setupFilesAfterEnv > 0 then
			local resolved = {}

			for _, setupPath in config.setupFilesAfterEnv do
				table.insert(resolved, InstanceResolver.findInstance(setupPath))
			end

			config.setupFilesAfterEnv = resolved :: any
		end
		local t_resolveSetupFiles = os.clock()

		local setupTimingState =
			SetupTiming.patch(findValue, config.setupFiles :: any, config.setupFilesAfterEnv :: any)

		-- Strip our own keys before Jest.runCLI (safe: single-task execution per VM)
		config.runnerTiming = nil :: any
		config.runnerCoverage = nil :: any
		config.runnerPerTestCoverage = nil :: any
		config.runnerTimeoutMs = nil :: any
		config.runnerCaptureGameOutput = nil :: any

		local coverage = RunnerResult.beginCoverage(findValue, {
			coverage = coverageEnabled,
			perTest = perTestEnabled,
		})

		local t_jestRunCLI0 = os.clock()
		local runCLIOk, runCLIValue = pcall(function()
			-- Held so the watchdog can cancel it: the thread an infinite yield
			-- parks is this promise's executor, not the one waiting on it.
			pending = Jest.runCLI(callingScript, config, projects)
			return pending:expect()
		end)
		local t_jestRunCLI = os.clock()

		local setupSeconds = SetupTiming.getSeconds(setupTimingState)
		SetupTiming.unpatch(setupTimingState)

		if not runCLIOk then
			error(PromiseError.normalize(runCLIValue), 0)
		end

		-- Through the seam the workspace runner assembles through too.
		return RunnerResult.build(runCLIValue, {
			coverage = coverage,
			setupSeconds = setupSeconds,
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
		})
	end

	-- The guarded span starts here rather than at findJest: what runs before it
	-- is instance lookup, which never waits on the DataModel. The yields this
	-- catches come from a test module's own imports, under `Jest.runCLI`.
	-- Read before `runTests` strips it off the config for Jest.
	local budgetMs = config.runnerTimeoutMs
	local runSuccess, runValue, timedOut = InfiniteYield.guard(runTests, {
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

	SnapshotPatch.unpatch(patchState)

	local jestResult
	if not runSuccess then
		jestResult = HttpService:JSONEncode(fail(runValue :: any))
	else
		jestResult = HttpService:JSONEncode(runValue)
	end

	local bannerEncodeOk, bannerEncoded = pcall(function()
		return HttpService:JSONEncode(capturedMessages)
	end)

	return jestResult, encodeGameOutput(), if bannerEncodeOk then bannerEncoded else "[]", timedOut
end

type ProjectEntry = {
	jestOutput: string,
	gameOutput: string,
	bannerOutput: string,
	elapsedMs: number,
	timedOut: boolean?,
}

local function encodeExecutionError(err: any): string
	return HttpService:JSONEncode({
		success = true,
		value = {
			kind = "ExecutionError",
			error = tostring(err),
		},
	})
end

-- Per-config hooks. Studio passes `beforeConfig` to inject the current
-- config's `jest.config` ModuleScripts and `afterConfig` to destroy them
-- before the next config runs. Per-config (not upfront-all) avoids
-- nested-project DataModel contamination where configs at e.g.
-- `ReplicatedStorage` and `ReplicatedStorage/Foo` would both have stubs
-- present simultaneously and Jest's parent-traversal config lookup could
-- resolve the wrong one. Open-cloud passes no hooks — its stubs are baked
-- into the place file by the synthesizer.
type RunHooks = {
	beforeConfig: ((cfg: Config, index: number) -> ())?,
	afterConfig: ((cfg: Config, index: number) -> ())?,
}

-- TODO(runner-tests): dogfood harness for Runner.runProjects
function module.runProjects(
	callingScript: LuaSourceContainer,
	configs: { Config },
	hooks: RunHooks?
): { ProjectEntry }
	local entries: { ProjectEntry } = {}

	for index, cfg in configs do
		local start = os.clock()
		local beforeOk: boolean, beforeErr: any = true, nil
		if hooks and hooks.beforeConfig then
			-- beforeConfig runs inside pcall too: a failed injection
			-- mid-mount must still trigger afterConfig so partially-
			-- parented stubs get destroyed. Without pcall, a throw would
			-- propagate out and afterConfig would never fire.
			beforeOk, beforeErr = pcall(hooks.beforeConfig, cfg, index)
		end

		local ok: boolean, jestOutput: any, gameOutput: any, bannerOutput: any, timedOut: any =
			false, nil, nil, nil, nil
		if beforeOk then
			ok, jestOutput, gameOutput, bannerOutput, timedOut =
				pcall(module.run, callingScript, cfg)
		else
			jestOutput = beforeErr
		end
		local elapsedMs = math.floor((os.clock() - start) * 1000)

		-- Always run afterConfig, even on failure — cleanup must be
		-- unconditional so injected ModuleScripts don't leak into the next
		-- iteration when Jest (or the beforeConfig itself) throws partway
		-- through.
		if hooks and hooks.afterConfig then
			local cleanupOk, cleanupErr = pcall(hooks.afterConfig, cfg, index)
			if not cleanupOk then
				warn("Runner afterConfig hook threw: " .. tostring(cleanupErr))
			end
		end

		if ok then
			entries[index] = {
				jestOutput = jestOutput :: string,
				gameOutput = gameOutput :: string,
				bannerOutput = bannerOutput :: string,
				elapsedMs = elapsedMs,
				timedOut = if timedOut then true else nil,
			}
		else
			entries[index] = {
				jestOutput = encodeExecutionError(jestOutput),
				gameOutput = "[]",
				bannerOutput = "[]",
				elapsedMs = elapsedMs,
			}
		end
	end

	return entries
end

return module
