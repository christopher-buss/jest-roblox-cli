--!strict
-- The TS side reads the `runner` key via `RunnerFields` in src/protocol/runner-fields.ts.
local CooperativeScheduler = require("./cooperative-scheduler")
local Envelope = require("./envelope")
local GameOutputCapture = require("./game-output-capture")
local InstanceResolver = require("./instance-resolver")
local LastSeen = require("./last-seen")
local PerTestCoverage = require("./per-test-coverage")
local Protocol = require("./protocol")

export type CoverageState = {
	hits: { [string]: any }?,
	perTest: PerTestCoverage.Installation?,
}

export type CoverageOptions = {
	coverage: boolean?,
	perTest: boolean?,
}

export type Dimensions = {
	coverage: CoverageState?,
	setupSeconds: number?,
	snapshotWrites: { [string]: string }?,
	timing: { [string]: number }?,
}

export type Abandon = "timeout"

export type Phase = string

export type FailureDimensions = {
	abandon: Abandon?,
	captureInstalled: boolean?,
	code: string?,
	phase: Phase?,
}

export type RunnerFields = {
	abandon: Abandon?,
	captureInstalled: boolean?,
	code: string?,
	coverage: { [string]: any }?,
	perTestCoverage: { PerTestCoverage.Record }?,
	phase: Phase?,
	setup: number?,
	snapshotWrites: { [string]: string }?,
	timing: { [string]: number }?,
}

export type Payload = {
	err: any?,
	runner: RunnerFields?,
	success: boolean,
	value: any?,
}

local module = {}

-- `circus/state`, not the package root: the root omits addEventHandler.
local function findCircusState(circusModule: Instance): ModuleScript
	local state = InstanceResolver.findCircusModule(circusModule, "state")
	assert(
		state and state:IsA("ModuleScript"),
		"jest-circus exposes no circus/state module to register the coverage hook on"
	)

	return state :: ModuleScript
end

type HookModules = {
	circusState: ModuleScript,
	getMatcherState: () -> any,
	runtimeClass: any,
}

-- Never memoized: a cache would answer for a torn-down jest clone.
local function resolveHookModules(jestModule: ModuleScript): HookModules
	local circusModule =
		InstanceResolver.findSiblingPackage(jestModule, "JestCircus", "jest-circus")
	local expectModule = InstanceResolver.findSiblingPackage(jestModule, "Expect", "expect")
	local runtimeModule =
		InstanceResolver.findSiblingPackage(jestModule, "JestRuntime", "jest-runtime")
	assert(
		circusModule and expectModule and runtimeModule,
		"could not resolve the jest-circus / Expect / jest-runtime packages"
	)

	return {
		circusState = findCircusState(circusModule),
		getMatcherState = (require :: any)(expectModule).getState,
		runtimeClass = (require :: any)(runtimeModule),
	}
end

-- Not pcall-guarded: a silent attribution failure reads as a real answer.
local function armPerTestCoverage(
	jestModule: ModuleScript,
	hits: { [string]: any }
): PerTestCoverage.Installation
	local hooks = resolveHookModules(jestModule)

	return PerTestCoverage.arm({
		circusState = hooks.circusState,
		getCoverage = function()
			return hits
		end,
		getMatcherState = hooks.getMatcherState,
		runtimeClass = hooks.runtimeClass,
	})
end

-- Inside pcall: a record that cannot arm must never end the run.
function module.beginLastSeen(jestModule: ModuleScript): LastSeen.Watch
	local armed, watch = pcall(function()
		local hooks = resolveHookModules(jestModule)

		return LastSeen.arm({
			circusState = hooks.circusState,
			getMatcherState = hooks.getMatcherState,
			now = os.clock,
			runtimeClass = hooks.runtimeClass,
		})
	end)

	return if armed then watch else LastSeen.unarmed(tostring(watch))
end

function module.beginScheduling(jestModule: ModuleScript): () -> string?
	local ok, result = pcall(function()
		local hooks = resolveHookModules(jestModule)
		return CooperativeScheduler.arm({
			circusState = hooks.circusState,
			runtimeClass = hooks.runtimeClass,
			now = os.clock,
			yield = function()
				task.wait()
			end,
			cancel = task.cancel,
		})
	end)
	if ok then
		return result
	end
	local failure: string? = tostring(result)
	return function()
		local message = failure
		failure = nil
		return message
	end
end

function module.finishScheduling(stop: (() -> string?)?)
	if stop == nil then
		return
	end
	local failure = stop()
	if failure ~= nil then
		GameOutputCapture.note("Warning: cooperative test scheduling unavailable: " .. failure)
	end
end

function module.noteAbandon(watch: LastSeen.Watch?): string
	local note = LastSeen.describe(watch)
	GameOutputCapture.note(note)
	return note
end

-- Call immediately before `Jest.runCLI`: it resets the global probe sink.
function module.beginCoverage(jestModule: ModuleScript, options: CoverageOptions): CoverageState
	-- Before the early return: the hook patch outlives the run that armed it.
	PerTestCoverage.disarm()

	if not options.coverage then
		return {}
	end

	local hits = {}
	_G[Protocol.coverage.global] = hits

	return {
		hits = hits,
		perTest = if options.perTest then armPerTestCoverage(jestModule, hits) else nil,
	}
end

-- An absent dimension stays absent: an empty table encodes as `[]`.
function module.build(value: any, dimensions: Dimensions): Payload
	local runner: RunnerFields = {}

	local coverage = dimensions.coverage
	local hits = if coverage then coverage.hits else nil
	if hits ~= nil then
		-- Attach even when empty: no hits differs from no coverage run.
		runner.coverage = hits

		-- Raised here: a throw inside jest's per-file setup fails one file only.
		local perTest = (coverage :: CoverageState).perTest
		if perTest then
			local failure = perTest.failure
			if failure ~= nil then
				error("Per-test coverage attribution failed: " .. failure, 0)
			end

			if #perTest.records > 0 then
				runner.perTestCoverage = perTest.records
			end
		end
	end

	local setupSeconds = dimensions.setupSeconds
	if setupSeconds ~= nil and setupSeconds > 0 then
		runner.setup = setupSeconds
	end

	local snapshotWrites = dimensions.snapshotWrites
	if snapshotWrites ~= nil and next(snapshotWrites) then
		runner.snapshotWrites = snapshotWrites
	end

	runner.timing = dimensions.timing

	local payload: Payload = {
		success = true,
		value = value,
	}

	if next(runner :: any) then
		payload.runner = runner
	end

	return payload
end

function module.fail(err: any, dimensions: FailureDimensions?): Payload
	local payload: Payload = Envelope.failure(err) :: any

	if dimensions == nil then
		return payload
	end

	local fields: RunnerFields = {
		abandon = dimensions.abandon,
		captureInstalled = dimensions.captureInstalled,
		code = dimensions.code,
		phase = dimensions.phase,
	}
	if next(fields :: any) then
		payload.runner = fields
	end

	return payload
end

return module
