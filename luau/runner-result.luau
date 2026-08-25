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

local InstanceResolver = require("./instance-resolver")
local PerTestCoverage = require("./per-test-coverage")

--[=[
	Where one run's coverage lands, for `build` to read back once Jest returns.

	`hits` is the probe sink this run armed, so a run reports what it collected
	rather than whatever the global holds later; it is nil when the run collects
	no coverage at all. `records` is nil when per-test attribution is off or
	unavailable, and fills as tests run.
]=]
export type CoverageState = {
	hits: { [string]: any }?,
	records: { PerTestCoverage.Record }?,
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

export type RunnerFields = {
	coverage: { [string]: any }?,
	perTestCoverage: { PerTestCoverage.Record }?,
	setup: number?,
	snapshotWrites: { [string]: string }?,
	timing: { [string]: number }?,
}

export type Payload = {
	runner: RunnerFields?,
	success: boolean,
	value: any,
}

local module = {}

-- Install the per-test coverage hook against the same jest-circus and Expect
-- instances Jest itself uses. All resolution is pcall-guarded so a missing or
-- renamed package degrades to no attribution rather than failing the run; the
-- returned accumulator fills as tests run. The matcher state carries the current
-- file (`testPath`) and full test name (`currentTestName`).
local function installPerTestCoverage(
	jestModule: ModuleScript,
	hits: { [string]: any }
): { PerTestCoverage.Record }?
	local ok, recordsOrErr = pcall(function()
		local circusModule =
			InstanceResolver.findSiblingPackage(jestModule, "JestCircus", "jest-circus")
		local expectModule = InstanceResolver.findSiblingPackage(jestModule, "Expect", "expect")
		assert(circusModule and expectModule, "could not resolve jest-circus / Expect packages")

		local Circus = (require :: any)(circusModule)
		local Expect = (require :: any)(expectModule)

		return PerTestCoverage.install(Circus.addEventHandler, Expect.getState, function()
			return hits
		end)
	end)

	if ok then
		return recordsOrErr
	end

	warn("Per-test coverage attribution unavailable: " .. tostring(recordsOrErr))
	return nil
end

--[=[
	Arm the coverage dimensions for one Jest run, returning the state
	`build` reads back once the run is over.

	Called immediately before `Jest.runCLI`, not earlier: resetting the global
	probe sink here is what isolates one run's hits from the run before it,
	which workspace mode depends on to attribute coverage per package.

	Per run rather than once per VM, because workspace mode materializes a
	fresh Jest clone per package and the hook has to reach the circus that
	package requires. The projects of one package do share a clone, so each
	installs another handler that circus never drops: from then on every test
	pays one snapshot and one diff of the hit table per stale handler, into an
	accumulator nobody reads. Reusing the first install instead would cost
	nothing — but only if circus keeps its handlers across `runCLI` calls, and
	a wrong guess there loses attribution silently, which is the fault this
	seam exists to prevent. Measure that before trading it (HAL-449).
]=]
function module.beginCoverage(jestModule: ModuleScript, options: CoverageOptions): CoverageState
	if not options.coverage then
		return {}
	end

	local hits = {}
	_G.__jest_roblox_cov = hits

	return {
		hits = hits,
		records = if options.perTest then installPerTestCoverage(jestModule, hits) else nil,
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

		local records = (coverage :: CoverageState).records
		if records and #records > 0 then
			runner.perTestCoverage = records
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

return module
