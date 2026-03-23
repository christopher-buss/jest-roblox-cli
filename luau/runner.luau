--!strict
local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")

local InstanceResolver = require("./instance-resolver")
local SnapshotPatch = require("./snapshot-patch")

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

type CapturedMessage = { message: string, messageType: number, timestamp: number }

local function interceptWriteable(writeable: any, buffer: { CapturedMessage }, messageType: number)
	local original = writeable._writeFn
	if typeof(original) ~= "function" then
		return function() end
	end

	writeable._writeFn = function(data: string)
		table.insert(buffer, {
			message = data,
			messageType = messageType,
			timestamp = os.clock(),
		})
		original(data)
	end

	return function()
		writeable._writeFn = original
	end
end

local module = {}

function module.run(callingScript: LuaSourceContainer, config: Config): (string, string)
	local t0 = os.clock()
	local timingEnabled = config._timing
	local coverageEnabled = config._coverage

	local t_findJest0 = os.clock()
	local findSuccess, findValue = pcall(InstanceResolver.getJest, config)
	local t_findJest = os.clock()

	if not findSuccess then
		local logSuccess, logHistory = pcall(function()
			return HttpService:JSONEncode(LogService:GetLogHistory())
		end)

		return HttpService:JSONEncode(fail(findValue :: any)), if logSuccess then logHistory else "[]"
	end

	LogService:ClearOutput()

	local snapshotWrites: { [string]: string } = {}

	local t_patchSnapshot0 = os.clock()
	local patchState = SnapshotPatch.patch(findValue, snapshotWrites)
	local t_patchSnapshot = os.clock()

	local t_requireJest0 = os.clock()
	local Jest = (require :: any)(findValue)
	local t_requireJest = os.clock()

	-- Intercept Jest's stdout/stderr to capture output synchronously.
	-- Jest writes via process.stdout/stderr (Writeable objects whose _writeFn
	-- defaults to print). Wrapping _writeFn captures messages like
	-- "No tests found" that are printed just before exit(1) throws.
	local capturedMessages: { CapturedMessage } = {}
	local restoreStdout: (() -> ())?
	local restoreStderr: (() -> ())?

	local interceptOk = pcall(function()
		local nodeModules = findValue.Parent.Parent.Parent :: any
		local RobloxShared = (require :: any)(nodeModules["@rbxts-js"].RobloxShared)
		local process = RobloxShared.nodeUtils.process

		restoreStdout = interceptWriteable(process.stdout, capturedMessages, 0)
		restoreStderr = interceptWriteable(process.stderr, capturedMessages, 1)
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
			"No projects configured. Set 'projects' in jest.config.ts or pass --projects."
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

		-- Strip private keys before Jest.runCLI (safe: single-task execution per VM)
		config._timing = nil :: any
		config._coverage = nil :: any

		if coverageEnabled then
			_G.__jest_roblox_cov = {}
		end

		local t_jestRunCLI0 = os.clock()
		local jestResult = Jest.runCLI(callingScript, config, projects):expect()
		local t_jestRunCLI = os.clock()

		local result: { [string]: any } = {
			success = true,
			value = jestResult,
		}

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

	local jestResult
	if not runSuccess then
		jestResult = HttpService:JSONEncode(fail(runValue :: any))
	else
		jestResult = HttpService:JSONEncode(runValue)
	end

	local logSuccess, logHistory = pcall(function()
		return HttpService:JSONEncode(capturedMessages)
	end)

	return jestResult, if logSuccess then logHistory else "[]"
end

return module
