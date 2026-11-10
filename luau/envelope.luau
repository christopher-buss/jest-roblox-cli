--!strict
-- The wire shapes `src/protocol/envelope.ts` reads: a task's return envelope,
-- and the failure payload.
local Protocol = require("./protocol")

export type Entry = {
	bannerOutput: string?,
	elapsedMs: number?,
	gameOutput: string?,
	jestOutput: string,
	jobIndex: number?,
	pkg: string?,
	project: string?,
}

export type Outcome = {
	bailed: boolean?,
	batch: boolean?,
	deferred: boolean?,
}

export type Task = {
	bailed: boolean?,
	deferred: boolean?,
	entries: { Entry },
	gameOutputScope: string?,
}

export type Failure = {
	err: any,
	success: boolean,
}

local module = {}

function module.failure(err: any): Failure
	return { err = err, success = false }
end

function module.task(entries: { Entry }, outcome: Outcome?): Task
	local task: Task = { entries = entries }
	if outcome ~= nil then
		task.bailed = outcome.bailed or nil
		task.deferred = outcome.deferred or nil
		task.gameOutputScope = if outcome.batch then Protocol.envelope.batchGameOutputScope else nil
	end

	return task
end

return module
