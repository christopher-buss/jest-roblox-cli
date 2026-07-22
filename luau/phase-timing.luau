--!strict
-- Shared `_timing` envelope builder for the two Jest-on-Roblox runners:
-- `runner.luau` (single-mode, one run) and `staging/embedded-runner.luau`
-- (workspace mode, one call per project entry). Both measure the same
-- named phases (findJest, patchSnapshot, requireJest, resolveProjects,
-- resolveSetupFiles, jestRunCLI, total) via `os.clock()` pairs around their
-- own calls, then hand the durations here to assemble the result table.
-- Phase names are a wire contract with the TS-side parser
-- (`extractLuauTiming` in reporter/parser.ts) — do not rename here
-- independent of there.
--
-- Pure and Roblox-free by design so it's testable under `lute` without
-- faking `game`/services/Jest — see test/luau/phase-timing.spec.ts.

local module = {}

export type Phase = {
	name: string,
	seconds: number,
}

-- Returns nil when disabled so callers can do
-- `result._timing = PhaseTiming.build(...)` unconditionally instead of an
-- extra `if enabled then` branch around the assignment.
function module.build(enabled: boolean?, phases: { Phase }): { [string]: number }?
	if not enabled then
		return nil
	end

	local result: { [string]: number } = {}
	for _, phase in phases do
		result[phase.name] = phase.seconds
	end

	return result
end

return module
