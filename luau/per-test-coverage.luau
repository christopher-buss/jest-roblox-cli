--!strict
local Attribution = require("./coverage-attribution")
local CircusHook = require("./circus-hook")
local dataModelPath = require("./data-model-path")

type MatcherState = { currentTestName: string?, testPath: Instance? }
export type Record = { delta: any, testCaseId: string, testFilePath: string }

export type Installation = {
	failure: string?,
	records: { Record },
}

export type ArmOptions = {
	circusState: ModuleScript,
	getCoverage: () -> any,
	getMatcherState: () -> MatcherState,
	runtimeClass: any,
}

local module = {}

local armedInstallation: Installation? = nil

function module.install(
	addEventHandler: (handler: any) -> (),
	getMatcherState: () -> MatcherState,
	getCoverage: () -> any,
	installation: Installation
)
	local before: any = nil

	-- pcall: circus does not guard handlers; a throw rejects the run.
	-- runner-result raises the recorded failure once the run is over.
	addEventHandler(function(_self: any, event: { name: string })
		local ok, err = pcall(function()
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
				table.insert(installation.records, {
					delta = delta,
					testCaseId = state.currentTestName or "",
					testFilePath = if state.testPath then dataModelPath(state.testPath) else "",
				})
			end
		end)
		if not ok and installation.failure == nil then
			installation.failure = tostring(err)
		end
	end)
end

function module.arm(options: ArmOptions): Installation
	-- Disarm first: the standing per-file hook serves every armed consumer.
	module.disarm()

	local installation: Installation = { failure = nil, records = {} }

	CircusHook.arm({
		circusState = options.circusState,
		install = function(addEventHandler)
			module.install(
				addEventHandler,
				options.getMatcherState,
				options.getCoverage,
				installation
			)
		end,
		report = installation,
		runtimeClass = options.runtimeClass,
	})

	armedInstallation = installation
	return installation
end

function module.disarm()
	if armedInstallation ~= nil then
		CircusHook.disarm(armedInstallation)
		armedInstallation = nil
	end
end

return module
