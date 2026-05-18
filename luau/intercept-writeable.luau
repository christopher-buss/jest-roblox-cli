--!strict
-- Patches a Writeable's `_writeFn` to push every write into `buffer` (tagged
-- with `messageType` and a monotonic timestamp) before delegating to the
-- original. Returns a restore thunk; callers must invoke it to undo the patch,
-- otherwise the buffer leaks across runs and the original write side-effect
-- stays hidden behind our tap.
--
-- Used by both runner.luau (single-pkg) and staging/entry.luau (workspace) to
-- capture per-task stdout/stderr around Jest.runCLI so failure messages like
-- "No tests found, exiting with code 1" can be surfaced in the CLI banner.

local module = {}

export type CapturedMessage = { message: string, messageType: number, timestamp: number }

function module.intercept(
	writeable: any,
	buffer: { CapturedMessage },
	messageType: number
): () -> ()
	local original = writeable._writeFn
	if typeof(original) ~= "function" then
		return function() end
	end

	writeable._writeFn = function(data: string)
		table.insert(buffer, {
			message = data,
			messageType = messageType,
			timestamp = os.clock(),
		})
		original(data)
	end

	return function()
		writeable._writeFn = original
	end
end

return module
