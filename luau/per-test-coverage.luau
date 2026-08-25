--!strict
-- Per-test coverage hook. Installs a single jest-circus event handler that
-- snapshots the runtime hit table on `test_start` and diffs it on `test_done`,
-- attributing the newly-covered statements to the test that just ran. The test's
-- identity (file + full name) is read from the Expect matcher state, which jest
-- sets per-file (`testPath`) and per-test (`currentTestName`).
--
-- `addEventHandler`, `getMatcherState`, and `getCoverage` are injected so the
-- orchestration is testable under lute without a real circus or Roblox
-- DataModel. The runner passes `_G.__jest_roblox_cov` as the coverage source.

local Attribution = require("./coverage-attribution")

type MatcherState = { currentTestName: string?, testPath: Instance? }
export type Record = { delta: any, testCaseId: string, testFilePath: string }

local module = {}

-- Service-rooted DataModel path (the `game` root, whose parent is nil, is
-- excluded), slash-joined to match the form jest-roblox-cli's source mapper
-- resolves.
local function dataModelPath(instance: Instance): string
	local parts: { string } = {}
	local current: Instance? = instance
	while current and current.Parent ~= nil do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end

	return table.concat(parts, "/")
end

function module.install(
	addEventHandler: (handler: any) -> (),
	getMatcherState: () -> MatcherState,
	getCoverage: () -> any
): { Record }
	local records: { Record } = {}
	local before: any = nil

	-- Circus does not guard event handlers (a throw rejects the run's dispatch
	-- chain), so the whole body is pcall-wrapped: attribution is best-effort and
	-- must never break the coverage run it observes.
	addEventHandler(function(_self: any, event: { name: string })
		pcall(function()
			if event.name == "test_start" then
				before = Attribution.snapshot(getCoverage())
			elseif event.name == "test_done" then
				if before == nil then
					return
				end

				local delta = Attribution.diff(before, getCoverage())
				before = nil
				if next(delta) == nil then
					return
				end

				local state = getMatcherState()
				table.insert(records, {
					delta = delta,
					testCaseId = state.currentTestName or "",
					testFilePath = if state.testPath then dataModelPath(state.testPath) else "",
				})
			end
		end)
	end)

	return records
end

return module
