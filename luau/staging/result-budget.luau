--!strict
-- Bounds the return envelope of one workspace task.
--
-- Open Cloud rejects a task whose return value exceeds 4 MiB with
-- `Return results too large`, and it rejects the whole task — every package
-- that task ran is lost, not just the one that tipped it over. A work-stealing
-- worker drains the queue until it is empty, so a single fast worker can take
-- every entry in the run and blow the cap on its own.
--
-- A worker therefore stops taking new queue items once its envelope is full
-- and returns what it has. The items it did not take stay in the queue, and
-- the CLI launches another task to collect them.
--
-- Two questions, because the size of an entry is unknown until it has run.
-- `shouldStop` predicts, so the worker can refuse an entry rather than waste
-- the run on a result it will not return; `fits` decides once the entry has
-- been measured, and is what holds the cap.
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
	snapshotWrites: { [string]: string }?,
}

-- Well under Open Cloud's hard 4 MiB. The slack absorbs the envelope's own
-- scaffolding, which `measure` counts per entry but not once for the whole.
local DEFAULT_BUDGET_BYTES = 3400000

-- Per-entry JSON scaffolding: the key names, braces, commas and quotes that
-- wrap the measured fields.
local ENTRY_OVERHEAD_BYTES = 128

function module.new(budgetBytes: number?): Tracker
	return {
		budgetBytes = budgetBytes or DEFAULT_BUDGET_BYTES,
		largestBytes = 0,
		usedBytes = 0,
	}
end

-- Bytes `entry` will add to the encoded envelope.
function module.measure(entry: Measurable): number
	-- Nested rather than a module-level helper, and seeded at zero rather than
	-- at ENTRY_OVERHEAD_BYTES. Both work around `weld` bugs that corrupt the
	-- bundle while this source stays valid Luau: `rename-locals` prefixes a
	-- top-level local's definition but misses its call sites, and
	-- `inline-trivial-aliases` folds away a `local x = <other local>` binding
	-- even where `+=` later reassigns it. Either one emits a bundle that calls
	-- a nil value, and neither transform reaches a nested local. Remove these
	-- shapes once the bundler is fixed.
	local function encodedLength(text: string): number
		-- Each field lands in the envelope as a JSON string, so every quote,
		-- backslash and control byte in it costs a second byte. Jest output is
		-- itself JSON and therefore quote-dense, so assuming no inflation
		-- would let a worker take an entry that does not fit. Counted rather
		-- than guessed at a ratio, because a pessimistic ratio splits a run
		-- across far more tasks than it needs.
		local _, specials = string.gsub(text, '[%c"\\]', "")
		-- +2 for the surrounding quotes.
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

	local snapshotWrites = entry.snapshotWrites
	if snapshotWrites ~= nil then
		for key, value in snapshotWrites do
			total += encodedLength(key) + encodedLength(value)
		end
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
	in for it — `fits` asked of a guess. A run whose entries are many small
	ones followed by one large one defeats that guess, which is why the caller
	asks again once the entry has been measured.
]=]
function module.shouldStop(tracker: Tracker): boolean
	return not module.fits(tracker, tracker.largestBytes)
end

return module
