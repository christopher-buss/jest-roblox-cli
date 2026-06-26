--!strict
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsRunning() then
	return
end

-- Plugin/CLI protocol version. Must match `STUDIO_PROTOCOL_VERSION` in
-- `src/backends/studio.ts` and `STUDIO_CLI_PROTOCOL_VERSION` in
-- `src/backends/studio-cli.ts`. v3 added the run-mode workspace dispatch + this
-- version echo. The runner validates the version the CLI sent and echoes its own
-- in `EndTest`, so the CLI surfaces a clean "update the plugin" error against a
-- mismatched plugin rather than running with stale runtime semantics.
local PROTOCOL_VERSION = 3

-- Every result (success or failure) echoes `protocolVersion` so the studio-cli
-- host can detect a stale plugin: one predating this echo omits the field and
-- the host rejects it as a version mismatch.
local function endTest(jestOutput: string, gameOutput: string?): ()
	local ok, endErr = pcall(function()
		StudioTestService:EndTest({
			jestOutput = jestOutput,
			gameOutput = gameOutput or "[]",
			protocolVersion = PROTOCOL_VERSION,
		})
	end)
	if not ok then
		warn("[jest-roblox] EndTest failed: " .. tostring(endErr))
	end
end

local function endWithError(err: string): ()
	endTest(HttpService:JSONEncode({ success = false, err = err }), "[]")
end

local testArgs = StudioTestService:GetTestArgs()
if testArgs == nil then
	for _ = 1, 50 do
		task.wait(0.1)
		testArgs = StudioTestService:GetTestArgs()
		if testArgs ~= nil then
			break
		end
	end
end

if testArgs == nil then
	return
end

-- Version handshake: reject a missing or mismatched `protocolVersion` before
-- running anything, mirroring the WebSocket `version_mismatch` path. The error
-- envelope still echoes our version (via endTest), so the CLI surfaces the
-- upgrade message either through this error or the version echo.
local clientVersion = if typeof(testArgs.protocolVersion) == "number"
	then testArgs.protocolVersion
	else nil
if clientVersion ~= PROTOCOL_VERSION then
	endWithError(
		"Studio plugin protocol version mismatch — plugin v"
			.. tostring(PROTOCOL_VERSION)
			.. ", CLI v"
			.. tostring(clientVersion)
			.. ". Update the jest-roblox Studio plugin to match the CLI."
	)
	return
end

local loadStringEnabled = pcall(function()
	loadstring("return true")
end)

if not loadStringEnabled then
	endWithError("LoadString must be enabled in ServerScriptService to run tests")
	return
end

-- Dispatch by payload shape. A `workspace` payload drives the staged
-- materializer (clone each package from the mega-place's `__pkg_stage`, run,
-- reset) via the shared single-process embedded runner — the same code OCALE
-- runs, minus the MemoryStore queue. Otherwise the existing single-/multi-
-- project configs path runs `Runner.runProjects`.
if testArgs.workspace ~= nil then
	local embeddedOk, EmbeddedRunner =
		pcall(require, script.Parent.shared.staging["embedded-runner"])
	if not embeddedOk then
		endWithError(
			"Failed to require shared.staging.embedded-runner: " .. tostring(EmbeddedRunner)
		)
		return
	end

	local runOk, entriesOrErr = pcall(EmbeddedRunner.runEmbedded, script, testArgs.workspace)
	if not runOk then
		endWithError("EmbeddedRunner.runEmbedded threw: " .. tostring(entriesOrErr))
		return
	end

	endTest(HttpService:JSONEncode({ entries = entriesOrErr }), "[]")
	return
end

if testArgs.config == nil or testArgs.config.configs == nil then
	local keysOk, keys = pcall(HttpService.JSONEncode, HttpService, testArgs)
	endWithError(
		"testArgs.config.configs is nil. Keys: " .. (if keysOk then keys else "<unencodable>")
	)
	return
end

local configs = testArgs.config.configs

local requireOk, Runner = pcall(require, script.Parent.shared.runner)
if not requireOk then
	endWithError("Failed to require shared.runner: " .. tostring(Runner))
	return
end

-- Runtime injection of jest.config ModuleScripts per config. Studio +
-- multi-project does NOT write jest.config.luau into the user's source
-- tree — the configs travel via the WebSocket payload and we materialize
-- them into DataModel ModuleScripts just before Jest discovery runs. The
-- session-UUID `_G` key keeps each Run Mode invocation isolated against
-- re-entrancy (the assert below fails loud if state from a prior run
-- somehow persisted).
local SESSION_KEY = "__JEST_ROBLOX_RT_" .. HttpService:GenerateGUID(false):gsub("-", "")
assert(_G[SESSION_KEY] == nil, "Session key collision — re-entrant run detected")
_G[SESSION_KEY] = { configs = {} }

local function findInstance(path: string): Instance
	local parts = string.split(path, "/")
	local current: any = game:FindService(parts[1])
	assert(current, "service not found: " .. parts[1])
	for i = 2, #parts do
		current = current:FindFirstChild(parts[i])
		assert(current, "missing segment '" .. parts[i] .. "' in " .. path)
	end
	return current
end

-- Per-config record of injected ModuleScripts so cleanup after each
-- config's Jest invocation can destroy exactly the stubs that config
-- created. Per-config (rather than upfront-all) avoids the nested-project
-- contamination path where configs at e.g. `ReplicatedStorage` and
-- `ReplicatedStorage/Foo` would both have stubs in DataModel
-- simultaneously and Jest's parent-traversal could resolve the wrong one.
local injectedPerConfig: { [number]: { Instance } } = {}

-- The CLI sends a filtered `runtimeStubMounts[i]` list per config,
-- excluding mounts that already have a user-authored `jest.config.luau`
-- on disk (synced naturally by Rojo). We must iterate this filtered list,
-- not `cfg.projects`, or we'd inject over the user's canonical config.
-- Defaults to empty when the field is missing (defensive against
-- malformed payload from a divergent plugin).
local function injectStubsForConfig(cfg, configIndex: number, injectionPaths: { string })
	local sessionTable = _G[SESSION_KEY]
	sessionTable.configs[configIndex] = cfg
	-- Register the slot BEFORE parenting any stub. If a later mount
	-- throws (findInstance miss, structural collision), the partially-
	-- parented stubs are already tracked so cleanupStubsForConfig /
	-- cleanupAllStubs can find and destroy them. Without this, an early
	-- stub would linger in DataModel after cleanup.
	local injected: { Instance } = {}
	injectedPerConfig[configIndex] = injected

	for _, projectPath in injectionPaths do
		local leaf = findInstance(projectPath)
		assert(
			leaf:FindFirstChild("jest.config") == nil,
			"Structural collision: jest.config already exists under "
				.. projectPath
				.. ". This may be a user-authored config not declared as a string entry, "
				.. "a rojo tree mapping, or a model-file mount."
		)
		local stub = Instance.new("ModuleScript")
		stub.Name = "jest.config"
		stub.Source = string.format('return _G["%s"].configs[%d]', SESSION_KEY, configIndex)
		stub.Parent = leaf
		-- Record immediately after parenting so a subsequent mount's
		-- failure does not strand this one.
		table.insert(injected, stub)
	end
end

local function cleanupStubsForConfig(configIndex: number)
	local injected = injectedPerConfig[configIndex]
	if injected ~= nil then
		for _, inst in injected do
			pcall(function()
				inst:Destroy()
			end)
		end
		injectedPerConfig[configIndex] = nil
	end

	local sessionTable = _G[SESSION_KEY]
	if sessionTable ~= nil then
		sessionTable.configs[configIndex] = nil
	end
end

local function cleanupAllStubs()
	for index in injectedPerConfig do
		cleanupStubsForConfig(index)
	end
	_G[SESSION_KEY] = nil
end

-- Per-config injection target lists, parallel to `configs`. The CLI sends a
-- pre-filtered list excluding mount paths whose source tree already has a
-- user-authored `jest.config.luau` synced by Rojo. Empty entry (or missing
-- field) means: skip injection for this config. The hooks below let
-- `Runner.runProjects` call our inject/cleanup just-in-time per config, so
-- nested-project mounts (e.g. `ReplicatedStorage` and `ReplicatedStorage/Foo`)
-- never have stubs in DataModel simultaneously — which would let Jest's
-- parent-traversal config lookup resolve the wrong project's config.
local runtimeStubMounts: { { string } } = testArgs.runtimeStubMounts or table.create(#configs, {})

local hooks = {
	beforeConfig = function(cfg, index)
		local paths = runtimeStubMounts[index] or {}
		injectStubsForConfig(cfg, index, paths)
	end,
	afterConfig = function(_cfg, index)
		cleanupStubsForConfig(index)
	end,
}

local runOk, entriesOrErr = pcall(Runner.runProjects, script, configs, hooks)
-- Defensive: also clear `_G` even if every afterConfig hook already cleaned
-- per-config. Belt-and-suspenders against a hook-call that yielded early.
cleanupAllStubs()
if not runOk then
	endWithError("Runner.runProjects threw: " .. tostring(entriesOrErr))
	return
end

endTest(HttpService:JSONEncode({ entries = entriesOrErr }), "[]")
