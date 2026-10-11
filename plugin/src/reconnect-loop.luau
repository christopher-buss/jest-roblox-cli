--!strict

export type Attempt = {
	failed: () -> (),
	opened: () -> (),
}

type Options = {
	cancel: (thread: thread) -> (),
	connect: (attempt: Attempt) -> (),
	delay: (seconds: number, callback: () -> ()) -> thread,
	initialDelay: number,
	maxDelay: number,
}

export type ReconnectLoop = {
	start: (self: ReconnectLoop) -> (),
	stop: (self: ReconnectLoop) -> (),
}

local ReconnectLoop = {}

function ReconnectLoop.new(options: Options): ReconnectLoop
	local nextDelay = options.initialDelay
	local current: { settled: boolean }? = nil
	local pending: thread? = nil
	local loop = {} :: ReconnectLoop

	local function dial(): ()
		pending = nil
		local token = { settled = false }
		current = token

		options.connect({
			failed = function(): ()
				if current ~= token or token.settled then
					return
				end
				token.settled = true
				local delay = nextDelay
				nextDelay = math.min(nextDelay * 2, options.maxDelay)
				pending = options.delay(delay, dial)
			end,
			opened = function(): ()
				if current == token then
					nextDelay = options.initialDelay
				end
			end,
		})
	end

	function loop.start(self: ReconnectLoop): ()
		self:stop()
		nextDelay = options.initialDelay
		dial()
	end

	function loop.stop(_self: ReconnectLoop): ()
		current = nil
		if pending ~= nil then
			options.cancel(pending)
			pending = nil
		end
	end

	return loop
end

return ReconnectLoop
