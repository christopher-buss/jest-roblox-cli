--!strict
-- The one seam both Jest-on-Roblox runners assemble their result through:
-- `runner.luau` (multi mode, one run per config) and
-- `staging/embedded-runner.luau` (workspace mode, one run per package entry).
-- Everything a runner adds to Jest's own result lives under a single `runner`
-- key, so the TS side tells our fields from Jest's by structure rather than by
-- a name prefix — see the `RunnerFields` extractors in reporter/parser.ts.
--
-- Both modes route here because a result dimension added to one runner alone
-- goes missing from the other with no type error to catch it: the host parser
-- reads every field as optional, so an absent one reads as "the run had none"
-- rather than as a fault. Add a dimension here, not in a runner.
--
-- Both outcomes route here too — `build` for a run that produced a result and
-- `fail` for one that did not. A dimension only a failed run can carry has the
-- same seam as any other, rather than a field of its own beside the envelope.

local InstanceResolver = require("./instance-resolver")
local PerTestCoverage = require("./per-test-coverage")

--[=[
	Where one run's coverage lands, for `build` to read back once Jest returns.

	`hits` is the probe sink this run armed, so a run reports what it collected
	rather than whatever the global holds later; it is nil when the run collects
	no coverage at all. `perTest` is nil when attribution is off, and otherwise
	fills as the run's test files install the hook and their tests run.
]=]
export type CoverageState = {
	hits: { [string]: any }?,
	perTest: PerTestCoverage.Installation?,
}

-- What a run collects beyond Jest's own result. Attribution rides on coverage
-- because it is a diff of the same sink: asking for it without coverage would
-- attribute nothing.
export type CoverageOptions = {
	coverage: boolean?,
	perTest: boolean?,
}

-- What a runner measured, in the units it measured them in. Everything is
-- optional: a runner passes only the dimensions its mode collected, and the
-- empty-is-absent rules below decide what reaches the wire.
export type Dimensions = {
	coverage: CoverageState?,
	setupSeconds: number?,
	snapshotWrites: { [string]: string }?,
	timing: { [string]: number }?,
}

--[=[
	Why a run stopped short of producing a result at all.

	Only a failed run carries one, which is why it is named rather than a
	boolean: the next reason a run is given up on is a second value here, not a
	second flag threaded down the wire beside this one.
]=]
export type Abandon = "timeout"

-- What a runner measured about a run that produced no result. Same
-- empty-is-absent rule as `Dimensions`: a failure the runner did not abandon
-- passes nothing and the envelope grows no `runner` block.
export type FailureDimensions = {
	abandon: Abandon?,
}

export type RunnerFields = {
	abandon: Abandon?,
	coverage: { [string]: any }?,
	perTestCoverage: { PerTestCoverage.Record }?,
	setup: number?,
	snapshotWrites: { [string]: string }?,
	timing: { [string]: number }?,
}

-- `value` on a run that produced a result, `err` on one that did not. The two
-- halves share a shape so the host reads the `runner` block the same way
-- whichever half it holds.
export type Payload = {
	err: any?,
	runner: RunnerFields?,
	success: boolean,
	value: any?,
}

local module = {}

-- Where circus keeps its dispatch registry. The JestCircus package root
-- re-exports `circus/init`, which forwards `setState`, `getState`,
-- `resetState`, `run` and the test globals but NOT `addEventHandler` — that
-- lives one module down, on `circus/state`. Reading the symbol off the root
-- yields nil, and calling it throws from inside the run.
local function findCircusState(circusModule: Instance): ModuleScript
	local circus = circusModule:FindFirstChild("circus")
	local state = if circus then circus:FindFirstChild("state") else nil
	assert(
		state and state:IsA("ModuleScript"),
		"jest-circus exposes no circus/state module to register the coverage hook on"
	)

	return state :: ModuleScript
end

--[=[
	Arm per-test attribution against the jest instance this run uses.

	Nothing here is pcall-guarded. A coverage run whose attribution silently
	fails reads downstream as "no test covered anything", which credits every
	statement to no test at all and lands every covered mutant on Ignored —
	indistinguishable from a real answer, and green. Failing the run is the
	only outcome a consumer can tell apart.
]=]
local function armPerTestCoverage(
	jestModule: ModuleScript,
	hits: { [string]: any }
): PerTestCoverage.Installation
	local circusModule =
		InstanceResolver.findSiblingPackage(jestModule, "JestCircus", "jest-circus")
	local expectModule = InstanceResolver.findSiblingPackage(jestModule, "Expect", "expect")
	local runtimeModule =
		InstanceResolver.findSiblingPackage(jestModule, "JestRuntime", "jest-runtime")
	assert(
		circusModule and expectModule and runtimeModule,
		"could not resolve the jest-circus / Expect / jest-runtime packages"
	)

	-- Expect's matcher state lives under a globally-registered symbol in `_G`,
	-- so this copy reads the same state the per-file copies write. Circus's
	-- handler list does not, which is why that one is resolved per test file.
	local Expect = (require :: any)(expectModule)

	return PerTestCoverage.arm({
		circusState = findCircusState(circusModule),
		getCoverage = function()
			return hits
		end,
		getMatcherState = Expect.getState,
		runtimeClass = (require :: any)(runtimeModule),
	})
end

--[=[
	Arm the coverage dimensions for one Jest run, returning the state
	`build` reads back once the run is over.

	Called immediately before `Jest.runCLI`, not earlier: resetting the global
	probe sink here is what isolates one run's hits from the run before it,
	which workspace mode depends on to attribute coverage per package.

	Per run rather than once per VM, because workspace mode materializes a
	fresh Jest clone per package and the hook has to reach the circus that
	package requires. Arming is cheap: the handler itself goes in per test
	file, from inside the registry that file dispatches through. A package's
	projects are separate runs against that one clone, so the second arms
	again and gets an accumulator of its own.
]=]
function module.beginCoverage(jestModule: ModuleScript, options: CoverageOptions): CoverageState
	-- Unconditionally, and before the early return: the per-file hook rides on
	-- a patch that outlives the run that installed it, so a run wanting no
	-- attribution has to say so or it keeps filling the last run's sink.
	PerTestCoverage.disarm()

	if not options.coverage then
		return {}
	end

	local hits = {}
	_G.__jest_roblox_cov = hits

	return {
		hits = hits,
		perTest = if options.perTest then armPerTestCoverage(jestModule, hits) else nil,
	}
end

--[=[
	Assemble the envelope a runner returns for one Jest run.

	A dimension the run did not produce stays absent rather than encoding as an
	empty value: an empty Luau table encodes as `[]`, which reads on the host as
	a populated-but-empty answer instead of no answer at all.
]=]
function module.build(value: any, dimensions: Dimensions): Payload
	local runner: RunnerFields = {}

	local coverage = dimensions.coverage
	local hits = if coverage then coverage.hits else nil
	if hits ~= nil then
		-- Attached whole and unconditionally: a run that collected coverage
		-- and hit nothing is a different answer from a run that collected none.
		runner.coverage = hits

		-- Raised here rather than where it happened: the install runs inside
		-- jest's own per-file setup, where a throw would fail one test file and
		-- read as a test failure. This is the first point at which the run as a
		-- whole can refuse to report — see `armPerTestCoverage` for why it must.
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

--[=[
	Assemble the envelope a runner returns for a run that produced no result.

	`build`'s other half, and here for the same reason: a dimension only a
	failed run can carry — why the run was given up on — otherwise has no seam
	to land on, and gets plumbed per runner and then again across the wire as a
	field of its own. Kept beside `build` so both halves put a runner's fields
	under the same `runner` key, and the host reads them in one place.
]=]
function module.fail(err: any, dimensions: FailureDimensions?): Payload
	local payload: Payload = {
		err = err,
		success = false,
	}

	local abandon = if dimensions then dimensions.abandon else nil
	if abandon ~= nil then
		payload.runner = { abandon = abandon }
	end

	return payload
end

return module
