--!strict
-- Phase names are a wire contract with `extractLuauTiming` in
-- jest-output/parser.ts.
-- No Roblox globals: test/luau/phase-timing.spec.ts runs this under Lute.
local module = {}

export type Phase = {
	name: string,
	seconds: number,
}

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
