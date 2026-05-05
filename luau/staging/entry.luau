--!strict
local HttpService = game:GetService("HttpService")

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
		[string]: any,
	},
}

type Payload = {
	entries: { EntryPayload },
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

	local result = Jest.runCLI(script, entry.config, projectInstances):expect()
	return HttpService:JSONEncode(result.results or result)
end

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local results = {}
local gameOutputs = {}
local prevPkg: string? = nil

for _, entry in payload.entries do
	if entry.pkg ~= prevPkg then
		if prevPkg ~= nil then
			Materializer.reset()
		end
		Materializer.materialize(entry.pkg)
		prevPkg = entry.pkg
	end

	local t0 = os.clock()
	local ok, jestOrError = pcall(runEntry, entry)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	if ok then
		table.insert(results, {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = jestOrError,
		})
	else
		table.insert(results, {
			pkg = entry.pkg,
			project = entry.project,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = tostring(jestOrError),
			}),
		})
	end

	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({ entries = results }), table.concat(gameOutputs, "")
