--!strict
local InstanceResolver = require("./instance-resolver")
local InterceptWriteable = require("./intercept-writeable")

type CapturedMessage = InterceptWriteable.CapturedMessage

local module = {}

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
