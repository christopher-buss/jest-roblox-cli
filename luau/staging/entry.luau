--!strict
local HttpService = game:GetService("HttpService")
local MemoryStoreService = game:GetService("MemoryStoreService")

local InstanceResolver = require("../instance-resolver")
local Materializer = require("./materializer")

type EntryPayload = {
	pkg: string,
	project: string,
	config: {
		jestPath: string?,
		projects: { string }?,
		setupFiles: { string }?,
		setupFilesAfterEnv: { string }?,
		_coverage: boolean?,
		[string]: any,
	},
}

type Payload = {
	entries: { EntryPayload },
	queueId: string?,
	invisibilityWindowSeconds: number?,
}

type QueueItem = {
	pkg: string,
	project: string,
}

type ResultEntry = {
	pkg: string,
	project: string,
	elapsedMs: number,
	jestOutput: string,
}

type JestResultPayload = {
	success: boolean,
	value: any?,
	err: any?,
	_coverage: { [string]: any }?,
}

local function resolveSetupPaths(paths: { string }?): { Instance }?
	if paths == nil or #paths == 0 then
		return paths :: any
	end

	local resolved = {}
	for _, setupPath in paths do
		table.insert(resolved, InstanceResolver.findInstance(setupPath))
	end

	return resolved
end

local function runEntry(entry: EntryPayload): string
	local JestModule = InstanceResolver.getJest(entry.config)
	local Jest = (require :: any)(JestModule)

	local projectInstances = {}
	if entry.config.projects then
		for _, projectPath in entry.config.projects do
			table.insert(projectInstances, InstanceResolver.findInstance(projectPath))
		end
	end
	entry.config.projects = {}

	-- Resolve setupFiles / setupFilesAfterEnv from DataModel-path strings to
	-- ModuleScript Instances. Jest expects Instances; without this the run
	-- crashes when setup files are configured at the package level.
	entry.config.setupFiles = resolveSetupPaths(entry.config.setupFiles) :: any
	entry.config.setupFilesAfterEnv = resolveSetupPaths(entry.config.setupFilesAfterEnv) :: any

	local coverageEnabled = entry.config._coverage == true
	if coverageEnabled then
		-- Per-package isolation: reset the global probe sink immediately
		-- before Jest.runCLI so the captured map only contains hits from
		-- this package's instrumented sources.
		_G.__jest_roblox_cov = {}
		entry.config._coverage = nil :: any
	end

	local result = Jest.runCLI(script, entry.config, projectInstances):expect()

	local payload: JestResultPayload = {
		success = true,
		value = result.results or result,
	}
	if coverageEnabled then
		payload._coverage = _G.__jest_roblox_cov
	end

	return HttpService:JSONEncode(payload)
end

local function executeEntry(
	entry: EntryPayload,
	prevPkg: string?
): (ResultEntry, string)
	if entry.pkg ~= prevPkg then
		if prevPkg ~= nil then
			Materializer.reset()
		end
		Materializer.materialize(entry.pkg)
	end

	local t0 = os.clock()
	local ok, jestOrError = pcall(runEntry, entry)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	local result: ResultEntry
	if ok then
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = jestOrError,
		}
	else
		result = {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = tostring(jestOrError),
			}),
		}
	end

	return result, entry.pkg
end

local function runEmbedded(payload: Payload): { ResultEntry }
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil

	for _, entry in payload.entries do
		local result, pkg = executeEntry(entry, prevPkg)
		table.insert(results, result)
		prevPkg = pkg
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results
end

local function runWorkStealing(payload: Payload): { ResultEntry }
	local queueId = payload.queueId :: string
	local invisibility = payload.invisibilityWindowSeconds or 90

	local entryByKey: { [string]: EntryPayload } = {}
	for _, entry in payload.entries do
		entryByKey[entry.pkg .. "::" .. entry.project] = entry
	end

	local queue = MemoryStoreService:GetQueue(queueId, invisibility)
	local results: { ResultEntry } = {}
	local prevPkg: string? = nil

	while true do
		-- waitTimeout=0: poll non-blocking. Invisibility is already set at
		-- GetQueue time above; using the full window here would stall the
		-- loop for ~invisibility seconds on the final empty read, adding
		-- that as tail latency across every parallel worker.
		local readOk, items, removeId = pcall(function()
			return queue:ReadAsync(1, false, 0)
		end)

		if not readOk then
			-- Surface the transient API error in game output instead of
			-- silently breaking; the outer "no entries for N packages"
			-- message wouldn't otherwise hint at the cause.
			warn("[work-stealing] ReadAsync failed: " .. tostring(items))
			break
		end

		if items == nil or #items == 0 then
			break
		end

		local item = items[1] :: QueueItem
		local key = item.pkg .. "::" .. item.project
		local entry = entryByKey[key]
		if entry == nil then
			-- Foreign / stale queue item — discard and keep popping.
			pcall(function()
				queue:RemoveAsync(removeId)
			end)
			continue
		end

		local result, pkg = executeEntry(entry, prevPkg)
		table.insert(results, result)
		prevPkg = pkg

		pcall(function()
			queue:RemoveAsync(removeId)
		end)
	end

	if prevPkg ~= nil then
		Materializer.reset()
	end

	return results
end

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local results: { ResultEntry }
if payload.queueId ~= nil and payload.queueId ~= "" then
	results = runWorkStealing(payload)
else
	results = runEmbedded(payload)
end

local gameOutputs = {}
for _ = 1, #results do
	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({ entries = results }), table.concat(gameOutputs, "")
