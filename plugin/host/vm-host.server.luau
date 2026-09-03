--!strict
--[[
	One Luau VM's worth of an in-session parallel run.

	Scripts under an `Actor` run in their own Luau VM, so this host gets its own
	`_G`, its own module cache, and its own copy of every module it requires —
	including Jest's. That is what makes overlapping `Jest.runCLI` calls safe:
	the runner's process-wide patches (game output capture, stdout intercept,
	coverage sink, setup timing, snapshot patch) and Jest's own `_G` run state
	are per-VM here, so each host simply runs today's sequential
	`Runner.runProjects` over its slice.

	The host lives in the plugin's tree, not the place's, because jest-runtime
	loads modules through `loadstring(ModuleScript.Source)` and reading `Source`
	needs plugin identity. A host baked into the place fails every suite with
	"lacking capability PluginOrOpenCloud".
]]
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

-- Set once `BindToMessage` is live. The coordinator waits for this rather than
-- sleeping: a message sent before the bind is dropped, which would strand the
-- whole slice. Anything that throws before it — a missing results channel, an
-- unloadable planner — leaves the host un-ready, and the coordinator runs
-- without it rather than waiting on a host that will never answer.
local READY_ATTRIBUTE = "JestRobloxVmHostReady"

local actor = script:GetActor()
if actor == nil or not RunService:IsRunning() then
	return
end

local results = script.Parent.Parent.results :: BindableEvent
local VmParallel = require(script.Parent.shared["vm-parallel"])

local function encode(value: any): string
	return HttpService:JSONEncode(value)
end

local function report(configIndex: number, entry: any): ()
	-- Sent as primitives, not as the entry table: the values cross a VM
	-- boundary, and `jestOutput` is already an encoded string, so re-encoding a
	-- wrapper around it would copy a whole run's output twice.
	--
	-- `gameOutput` is deliberately not sent. `LogService.MessageOut` carries no
	-- source identity, so under parallel every host captures every other host's
	-- output; the coordinator owns one batch-scoped capture instead, and the
	-- CLI labels it as batch-scoped.
	results:Fire(configIndex, entry.jestOutput, entry.bannerOutput, entry.elapsedMs, entry.timedOut)
end

--[[
	Report every config in this slice as an ExecutionError. Failure is isolated
	to the slice: the other hosts' entries still come back normally, and the
	coordinator drops these into their requested positions.
]]
local function reportSliceFailure(indices: { number }, message: string): ()
	for _, configIndex in indices do
		report(configIndex, VmParallel.executionErrorEntry({ encode = encode, message = message }))
	end
end

--[[
	Run this host's slice and report each config's entry under the index the
	coordinator asked for.
]]
local function runSlice(payload: any): ()
	local indices: { number } = payload.indices

	local requireOk, modules = pcall(function(): any
		return {
			Runner = require(script.Parent.shared.runner),
			StubHooks = require(script.Parent.shared["runtime-stub-hooks"]),
		}
	end)
	if not requireOk then
		reportSliceFailure(indices, "VM host failed to require the runner: " .. tostring(modules))
		return
	end

	-- The coordinator owns the run's one Game Output capture, so the runner
	-- must not open a second one per config here: `LogService.MessageOut`
	-- reaches every listener in the DataModel, so each host would hold and
	-- encode a copy of the whole batch's log only for it to be discarded on
	-- the way back.
	for _, cfg in payload.configs do
		cfg.runnerCaptureGameOutput = false
	end

	-- The stubs this slice needs are injected here, in this VM: the stub's
	-- source reads its config out of `_G`, and the coordinator's `_G` is not
	-- ours.
	local hooks, cleanupAll =
		modules.StubHooks.create(payload.runtimeStubMounts or table.create(#indices, {}))
	local runOk, entriesOrError = pcall(modules.Runner.runProjects, script, payload.configs, hooks)
	cleanupAll()

	if not runOk then
		reportSliceFailure(indices, "VM host slice threw: " .. tostring(entriesOrError))
		return
	end

	for sliceIndex, configIndex in indices do
		local entry = entriesOrError[sliceIndex]
		if entry == nil then
			report(
				configIndex,
				VmParallel.executionErrorEntry({
					encode = encode,
					message = "VM host produced no entry for this project",
				})
			)
			continue
		end

		report(configIndex, entry)
	end
end

actor:BindToMessage("run", function(rawPayload: string): ()
	-- The run yields (Jest awaits its own promise) and a BindToMessage callback
	-- may not, so the slice runs on its own thread.
	task.spawn(function(): ()
		local decodeOk, payload = pcall(function(): any
			return HttpService:JSONDecode(rawPayload)
		end)
		if not decodeOk then
			warn("[jest-roblox] VM host could not decode its slice: " .. tostring(payload))
			return
		end

		local sliceOk, err = pcall(runSlice, payload)
		if not sliceOk then
			reportSliceFailure(payload.indices, "VM host errored: " .. tostring(err))
		end
	end)
end)

script:SetAttribute(READY_ATTRIBUTE, true)
