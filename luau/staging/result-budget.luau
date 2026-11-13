--!strict
local module = {}

export type Tracker = {
	budgetBytes: number,
	largestBytes: number,
	usedBytes: number,
}

export type Measurable = {
	bannerOutput: string?,
	gameOutput: string?,
	jestOutput: string,
	pkg: string,
	project: string,
}

local DEFAULT_BUDGET_BYTES = require("../protocol").limits.resultBudgetBytes

local ENTRY_OVERHEAD_BYTES = 128

function module.new(budgetBytes: number?): Tracker
	return {
		budgetBytes = budgetBytes or DEFAULT_BUDGET_BYTES,
		largestBytes = 0,
		usedBytes = 0,
	}
end

function module.measure(entry: Measurable): number
	-- Nested, and seeded at zero: works around `weld` bugs in `rename-locals`
	-- and `inline-trivial-aliases` that emit a nil call. Undo once fixed.
	local function encodedLength(text: string): number
		local _, specials = string.gsub(text, '[%c"\\]', "")
		return #text + specials + 2
	end

	local total = 0
	total += encodedLength(entry.jestOutput)
	total += encodedLength(entry.pkg)
	total += encodedLength(entry.project)

	local gameOutput = entry.gameOutput
	if gameOutput ~= nil then
		total += encodedLength(gameOutput)
	end

	local bannerOutput = entry.bannerOutput
	if bannerOutput ~= nil then
		total += encodedLength(bannerOutput)
	end

	return total + ENTRY_OVERHEAD_BYTES
end

function module.add(tracker: Tracker, bytes: number)
	tracker.usedBytes += bytes
	if bytes > tracker.largestBytes then
		tracker.largestBytes = bytes
	end
end

--[=[
	Whether an entry of `bytes` still fits the envelope.

	A worker that has taken nothing accepts whatever it is offered. Refusing
	the first entry would leave it for a successor that would refuse it in
	turn, so an entry larger than the whole budget would never go out at all.
]=]
function module.fits(tracker: Tracker, bytes: number): boolean
	if tracker.usedBytes == 0 then
		return true
	end

	return tracker.usedBytes + bytes <= tracker.budgetBytes
end

--[=[
	Whether the worker should stop taking new queue items.

	The next entry's size is unknown, so the largest one measured so far stands
	in for it: `fits` asked of a guess. A run whose entries are many small
	ones followed by one large one defeats that guess, which is why the caller
	asks again once the entry has been measured.
]=]
function module.shouldStop(tracker: Tracker): boolean
	return not module.fits(tracker, tracker.largestBytes)
end

return module
