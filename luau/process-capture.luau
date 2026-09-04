--!strict
-- Installs the stdout/stderr tap both runners read their Banner Output from:
-- `runner.luau` (multi) and `staging/embedded-runner.luau` (workspace). Jest
-- writes its exit-time messages ("No tests found, exiting with code 1") through
-- `process.stdout`, and a run that loses this tap reports an exit code with no
-- cause attached to it.

local InstanceResolver = require("./instance-resolver")
local InterceptWriteable = require("./intercept-writeable")

type CapturedMessage = InterceptWriteable.CapturedMessage

local module = {}

--[=[
	Tap `process.stdout` and `process.stderr` into `buffer` for the length of a
	run. Returns the thunk restoring both, or nil when the tap could not be
	installed.

	RobloxShared is resolved through the same walk snapshot support uses rather
	than through a fixed hop up the Jest module's ancestors: how deep the two
	packages sit under each other depends on how the consumer's tree mounts
	node_modules, and getting it wrong here costs the run its Banner Output
	without failing anything the reader would notice.
]=]
function module.install(jestModule: ModuleScript, buffer: { CapturedMessage }): (() -> ())?
	local ok, restore = pcall(function(): () -> ()
		local sharedInstance = InstanceResolver.findRobloxShared(jestModule)
		assert(sharedInstance, "Could not find RobloxShared")

		local RobloxShared = (require :: any)(sharedInstance)
		local process = RobloxShared.nodeUtils.process
		local restoreStdout = InterceptWriteable.intercept(process.stdout, buffer, 0)
		local restoreStderr = InterceptWriteable.intercept(process.stderr, buffer, 1)

		return function()
			restoreStdout()
			restoreStderr()
		end
	end)

	return if ok then restore else nil
end

return module
