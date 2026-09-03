--!strict
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsRunning() then
	return
end

-- Plugin/CLI protocol version. Must match `STUDIO_PROTOCOL_VERSION` in
-- `src/backends/studio.ts` and `STUDIO_CLI_PROTOCOL_VERSION` in
-- `src/backends/studio-cli.ts`. v7 adds the `runnerTimeoutMs` argv the runner
-- bounds a project's run with and strips before calling Jest, so a v6 plugin
-- handed one runs unbounded and passes the key on to Jest; v6 adds the plugin's
-- own release version to the result and the claim below; v5 added the optional
-- `vmParallel` count: a
-- plugin predating it would run a parallel request sequentially and say
-- nothing, so the handshake is what turns that into an "update the plugin"
-- error. v4 nested the fields the runner adds to Jest's result under `runner`
-- and renamed the frame key `request_id` to `requestId`. The runner validates
-- the version the CLI sent and echoes its own in `EndTest`, so the CLI
-- surfaces a clean error against a mismatched plugin rather than running with
-- stale runtime semantics.
local PROTOCOL_VERSION = 7

-- Written by `scripts/stamp-plugin-version.ts` at build time, and absent from a
-- tree served straight out of source control. Diagnostic only — see the same
-- lookup in `init.server.luau`.
local versionOk, PluginVersion = pcall(require, script.Parent:FindFirstChild("version") :: any)
if not versionOk or typeof(PluginVersion) ~= "string" then
	PluginVersion = "unknown"
end

-- Set by whichever installed copy of the plugin can serve this run. Studio
-- injects a run-mode runner for *every* installed copy, and they all reach
-- `EndTest` for the same run: without a claim, a stale copy's refusal lands
-- first and loses the run for a Studio that also has a working copy. Held on
-- ReplicatedStorage rather than the DataModel because the plugin already
-- carries an attribute there, so the surface is known to work.
local RUN_CLAIM_ATTRIBUTE = "JestRobloxRunClaimed"

-- How long a copy that cannot serve the run waits for a copy that can. Only
-- ever waited out in full when this is the sole installed copy, in which case
-- the mismatch is the run's real cause and has to be reported.
local MISMATCH_DEFER_SECONDS = 3

-- How long to wait for the actor hosts to bind their message handler. They
-- bind as the run-mode session starts, so this only absorbs the gap between
-- plugin scripts starting; a host still un-ready is one that failed to load,
-- and the run goes ahead without it.
local HOST_READY_TIMEOUT_SECONDS = 10

-- Set by each host once its `BindToMessage` is live. Mirrors
-- `plugin/host/vm-host.server.luau`.
local HOST_READY_ATTRIBUTE = "JestRobloxVmHostReady"

-- Every result (success or failure) echoes `protocolVersion` so the studio-cli
-- host can detect a stale plugin: one predating this echo omits the field and
-- the host rejects it as a version mismatch.
local function endTest(jestOutput: string, gameOutput: string?): ()
	local ok, endErr = pcall(function()
		StudioTestService:EndTest({
			jestOutput = jestOutput,
			gameOutput = gameOutput or "[]",
			protocolVersion = PROTOCOL_VERSION,
			pluginVersion = PluginVersion,
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
	-- Defer to any installed copy that can serve this run before reporting.
	-- Reporting straight away is what makes a stale copy fatal to a Studio
	-- that also has a working one: `EndTest` is first-past-the-post, and
	-- refusing costs nothing while running the suite takes seconds.
	local deadline = os.clock() + MISMATCH_DEFER_SECONDS
	repeat
		if ReplicatedStorage:GetAttribute(RUN_CLAIM_ATTRIBUTE) ~= nil then
			return
		end

		task.wait(0.05)
	until os.clock() >= deadline

	endWithError(
		"Studio plugin protocol version mismatch — plugin v"
			.. tostring(PROTOCOL_VERSION)
			.. " ("
			.. PluginVersion
			.. "), CLI v"
			.. tostring(clientVersion)
			.. ". Update the jest-roblox Studio plugin to match the CLI."
	)
	return
end

-- Claim the run before doing anything that takes time, so the copies that
-- cannot serve it stand down rather than answering in our place.
ReplicatedStorage:SetAttribute(RUN_CLAIM_ATTRIBUTE, PROTOCOL_VERSION)

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

local stubHooksOk, StubHooks = pcall(require, script.Parent.shared["runtime-stub-hooks"])
if not stubHooksOk then
	endWithError("Failed to require shared.runtime-stub-hooks: " .. tostring(StubHooks))
	return
end

local GameOutputCapture = require(script.Parent.shared["game-output-capture"])
local VmParallel = require(script.Parent.shared["vm-parallel"])

local function encode(value: any): string
	return HttpService:JSONEncode(value)
end

-- Per-config injection target lists, parallel to `configs`. The CLI sends a
-- pre-filtered list excluding mount paths whose source tree already has a
-- user-authored `jest.config.luau` synced by Rojo. Empty entry (or missing
-- field) means: skip injection for this config.
local runtimeStubMounts: { { string } } = testArgs.runtimeStubMounts or table.create(#configs, {})

--[[
	The actor hosts that have bound their message handler, up to `limit`.

	Level-triggered on purpose: a host signals readiness by setting an
	attribute, not by firing an event, so a host that bound before this runs is
	still seen. Sorted by name so slice 1 always lands on host1 — the dispatch
	is deterministic even though the DataModel child order need not be.
]]
local function collectReadyHosts(limit: number): { Actor }
	local folder = script.Parent:FindFirstChild("vmHosts")
	if folder == nil then
		return {}
	end

	local ready: { Actor } = {}
	local deadline = os.clock() + HOST_READY_TIMEOUT_SECONDS
	repeat
		table.clear(ready)
		local children = folder:GetChildren()
		table.sort(children, function(left: Instance, right: Instance): boolean
			return left.Name < right.Name
		end)

		for _, child in children do
			local hostScript = child:FindFirstChild("runner")
			if
				child:IsA("Actor")
				and hostScript ~= nil
				and hostScript:GetAttribute(HOST_READY_ATTRIBUTE) == true
			then
				table.insert(ready, child)
			end
		end

		if #ready >= limit then
			break
		end

		task.wait(0.05)
	until os.clock() >= deadline

	return ready
end

--[[
	Run the configs across `requested` Luau VMs and return the entries in
	request order plus the run's batch-scoped game output.

	Returns nil when no host was available, which leaves the caller on the
	plain sequential path rather than failing a run the session can still
	serve.
]]
local function runInVmHosts(requested: number): ({ any }?, string?)
	local hosts = collectReadyHosts(math.min(requested, #configs))
	if #hosts == 0 then
		warn("[jest-roblox] no parallel VM hosts became ready; running projects sequentially")
		return nil, nil
	end

	local results = script.Parent.vmHosts.results :: BindableEvent
	local received: { [number]: any } = {}
	local receivedCount = 0

	local connection = results.Event:Connect(
		function(
			configIndex: number,
			jestOutput: string,
			bannerOutput: string,
			elapsedMs: number,
			timedOut: boolean?
		)
			if received[configIndex] ~= nil then
				return
			end

			received[configIndex] = {
				bannerOutput = bannerOutput,
				elapsedMs = elapsedMs,
				jestOutput = jestOutput,
				timedOut = timedOut,
			}
			receivedCount += 1
		end
	)

	-- One capture for the whole batch, owned here. `LogService.MessageOut`
	-- reports every message to every listener with no source identity, so
	-- under parallel "which project printed this" is unanswerable; the hosts
	-- capture nothing and the CLI labels this as batch-scoped.
	local stopCapture = GameOutputCapture.start()

	local slices = VmParallel.planSlices({
		configCount = #configs,
		hostCount = math.min(requested, #hosts),
		mounts = runtimeStubMounts,
	})

	for hostIndex, slice in slices do
		local payload = { configs = {}, indices = slice, runtimeStubMounts = {} }
		for _, configIndex in slice do
			table.insert(payload.configs, configs[configIndex])
			table.insert(payload.runtimeStubMounts, runtimeStubMounts[configIndex] or {})
		end

		hosts[hostIndex]:SendMessage("run", encode(payload))
	end

	-- The main thread does the waiting because `StudioTestService:EndTest`
	-- must be called from the run-mode runner's own thread: called from inside
	-- the BindableEvent handler it fails with "can only be called from the
	-- server DataModel of a running Studio play session".
	-- Bounded by the budget the CLI sent rather than a constant of our own:
	-- the wait exists to turn a dead host into ExecutionError entries the CLI
	-- can render, and a wait outlasting the CLI's timeout delivers none of them
	-- (studio-cli has killed Studio by then).
	local waitSeconds = VmParallel.resolveHostDeadlineSeconds(testArgs.runBudgetMs)
	local deadline = os.clock() + waitSeconds
	while receivedCount < #configs and os.clock() < deadline do
		task.wait(0.05)
	end

	connection:Disconnect()

	return VmParallel.finalizeEntries({
		configCount = #configs,
		encode = encode,
		missingError = "The VM host running this project stopped answering (timed out after "
			.. string.format("%.0f", waitSeconds)
			.. "s)",
		received = received,
	}),
		stopCapture()
end

-- Experimental in-session parallelism, off unless the CLI asked for it. A
-- count of one is the sequential path by definition, so only a real split
-- takes the branch.
local vmParallel = if typeof(testArgs.vmParallel) == "number" then testArgs.vmParallel else 0
if vmParallel > 1 and #configs > 1 then
	local entries, gameOutput = runInVmHosts(vmParallel)
	if entries ~= nil then
		-- `gameOutputScope` reports what this run did rather than what it was
		-- asked to do: the fallback below runs the sequential path, where each
		-- project owns its capture again, and the CLI groups the output by
		-- this field rather than by the flag it sent.
		endTest(
			HttpService:JSONEncode({ entries = entries, gameOutputScope = "batch" }),
			gameOutput or "[]"
		)
		return
	end
end

-- The hooks let `Runner.runProjects` inject each config's `jest.config`
-- ModuleScripts just-in-time and destroy them before the next config runs, so
-- nested-project mounts (e.g. `ReplicatedStorage` and `ReplicatedStorage/Foo`)
-- never have stubs in DataModel simultaneously — which would let Jest's
-- parent-traversal config lookup resolve the wrong project's config.
local hooks, cleanupAllStubs = StubHooks.create(runtimeStubMounts)

local runOk, entriesOrErr = pcall(Runner.runProjects, script, configs, hooks)
-- Defensive: also clear `_G` even if every afterConfig hook already cleaned
-- per-config. Belt-and-suspenders against a hook-call that yielded early.
cleanupAllStubs()
if not runOk then
	endWithError("Runner.runProjects threw: " .. tostring(entriesOrErr))
	return
end

endTest(HttpService:JSONEncode({ entries = entriesOrErr }), "[]")
