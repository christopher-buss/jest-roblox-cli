--!strict
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

local InstanceResolver = require("./instance-resolver")
local InterceptWriteable = require("./intercept-writeable")
local PromiseError = require("./promise-error")
local SetupTiming = require("./setup-timing")
local SnapshotPatch = require("./snapshot-patch")

type CapturedMessage = InterceptWriteable.CapturedMessage

type Config = {
	jestPath: string?,
	projects: { string }?,
	setupFiles: { string }?,
	setupFilesAfterEnv: { string }?,
	_coverage: boolean?,
	_timing: boolean?,
}

local function fail(err: string)
	return {
		success = false,
		err = err,
	}
end

local module = {}

function module.run(callingScript: LuaSourceContainer, config: Config): (string, string, string)
	local t0 = os.clock()
	local timingEnabled = config._timing
	local coverageEnabled = config._coverage

	-- Game Output capture: subscribe to LogService.MessageOut at the top of
	-- the run so engine warnings during findJest/require(Jest) (broken
	-- jestPath, missing dep) also land in the user-facing `--gameOutput`
	-- dump. Disconnected last during teardown so late warns that fire after
	-- Promise:expect resumes the coroutine still reach us — GetLogHistory
	-- has a known gap here (plans/SNAPSHOT-SUPPORT.md).
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

	local function encodeGameOutput(): string
		local ok, encoded = pcall(function()
			return HttpService:JSONEncode(logMessages)
		end)
		return if ok then encoded else "[]"
	end

	local t_findJest0 = os.clock()
	local findSuccess, findValue = pcall(InstanceResolver.getJest, config)
	local t_findJest = os.clock()

	if not findSuccess then
		logConnection:Disconnect()
		return HttpService:JSONEncode(fail(findValue :: any)), encodeGameOutput(), "[]"
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

		local setupTimingState = SetupTiming.patch(
			findValue,
			config.setupFiles :: any,
			config.setupFilesAfterEnv :: any
		)

		-- Strip private keys before Jest.runCLI (safe: single-task execution per VM)
		config._timing = nil :: any
		config._coverage = nil :: any

		if coverageEnabled then
			_G.__jest_roblox_cov = {}
		end

		local t_jestRunCLI0 = os.clock()
		local runCLIOk, runCLIValue = pcall(function()
			return Jest.runCLI(callingScript, config, projects):expect()
		end)
		local t_jestRunCLI = os.clock()

		local setupSeconds = SetupTiming.getSeconds(setupTimingState)
		SetupTiming.unpatch(setupTimingState)

		if not runCLIOk then
			error(PromiseError.normalize(runCLIValue), 0)
		end

		local jestResult = runCLIValue

		local result: { [string]: any } = {
			success = true,
			value = jestResult,
		}

		if setupSeconds > 0 then
			result._setup = setupSeconds
		end

		if timingEnabled then
			result._timing = {
				findJest = t_findJest - t_findJest0,
				patchSnapshot = t_patchSnapshot - t_patchSnapshot0,
				requireJest = t_requireJest - t_requireJest0,
				resolveProjects = t_resolveProjects - t_resolveProjects0,
				resolveSetupFiles = t_resolveSetupFiles - t_resolveSetupFiles0,
				jestRunCLI = t_jestRunCLI - t_jestRunCLI0,
				total = os.clock() - t0,
			}
		end

		if next(snapshotWrites) then
			result._snapshotWrites = snapshotWrites
		end

		if coverageEnabled then
			result._coverage = _G.__jest_roblox_cov
		end

		return result
	end

	local jestDone = false
	local runSuccess = false
	local runValue: any = nil

	task.spawn(function()
		local ok, val = pcall(runTests)
		jestDone = true
		runSuccess = ok
		runValue = val
	end)

	local infiniteYieldMessage: string? = nil
	local watchdogConnection = LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
		if
			messageType == Enum.MessageType.MessageWarning
			and string.find(message, "Infinite yield possible")
			and not infiniteYieldMessage
		then
			infiniteYieldMessage = message
		end
	end)

	while not jestDone and not infiniteYieldMessage do
		task.wait(0.1)
	end

	watchdogConnection:Disconnect()

	if restoreStdout then
		restoreStdout()
	end

	if restoreStderr then
		restoreStderr()
	end

	if not jestDone and infiniteYieldMessage then
		runSuccess = false
		runValue = "Infinite yield detected, aborting tests: " .. infiniteYieldMessage
	end

	SnapshotPatch.unpatch(patchState)

	-- MessageOut listener stays connected through SnapshotPatch.unpatch and
	-- the encode below, so any disconnect-time warns still land in
	-- gameOutput.
	logConnection:Disconnect()

	local jestResult
	if not runSuccess then
		jestResult = HttpService:JSONEncode(fail(runValue :: any))
	else
		jestResult = HttpService:JSONEncode(runValue)
	end

	local bannerEncodeOk, bannerEncoded = pcall(function()
		return HttpService:JSONEncode(capturedMessages)
	end)

	return jestResult, encodeGameOutput(), if bannerEncodeOk then bannerEncoded else "[]"
end

type ProjectEntry = {
	jestOutput: string,
	gameOutput: string,
	bannerOutput: string,
	elapsedMs: number,
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

		local ok: boolean, jestOutput: any, gameOutput: any, bannerOutput: any =
			false, nil, nil, nil
		if beforeOk then
			ok, jestOutput, gameOutput, bannerOutput = pcall(module.run, callingScript, cfg)
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
