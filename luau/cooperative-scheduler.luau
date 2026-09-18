--!strict
local CircusHook = require("./circus-hook")

local SLICE_SECONDS = 0.1
local COMPLETION_EVENTS: { [string]: boolean } = {
	test_done = true,
	test_skip = true,
	test_todo = true,
	run_finish = true,
}

export type Options = {
	circusState: ModuleScript,
	runtimeClass: any,
	now: () -> number,
	yield: () -> (),
	cancel: (thread) -> (),
}

local module = {}

function module.arm(options: Options): () -> string?
	local active = true
	local parked: { [thread]: boolean } = {}
	local lastYield = options.now()
	local report: CircusHook.Report = {}
	CircusHook.arm({
		circusState = options.circusState,
		runtimeClass = options.runtimeClass,
		report = report,
		installLast = true,
		install = function(addEventHandler)
			addEventHandler(function(_self: any, event: { name: string })
				if not active or not COMPLETION_EVENTS[event.name] then
					return
				end
				if options.now() - lastYield >= SLICE_SECONDS then
					-- Completion dispatch is async and follows afterEach. Attribution
					-- observes the completed test before background work can resume.
					local thread = coroutine.running()
					parked[thread] = true
					options.yield()
					if active then
						parked[thread] = nil
						lastYield = options.now()
					end
				end
			end)
		end,
	})

	return function()
		if not active then
			return nil
		end
		active = false
		CircusHook.disarm(report)
		-- An awaited dispatch executor need not inherit runCLI cancellation.
		for thread in parked do
			parked[thread] = nil
			if thread ~= coroutine.running() and coroutine.status(thread) ~= "dead" then
				options.cancel(thread)
			end
		end
		return report.failure
	end
end

return module
