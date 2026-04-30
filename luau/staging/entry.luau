--!strict
local HttpService = game:GetService("HttpService")

local InstanceResolver = require("../instance-resolver")
local Materializer = require("./materializer")

type PackagePayload = {
	pkg: string,
	config: { jestPath: string?, [string]: any },
}

type Payload = {
	packages: { PackagePayload },
}

local function runPackage(pkgEntry: PackagePayload): string
	Materializer.materialize(pkgEntry.pkg)

	local JestModule = InstanceResolver.getJest(pkgEntry.config)
	local Jest = (require :: any)(JestModule)
	local projects = Materializer.collectJestConfigs()

	local result = Jest.runCLI(script, pkgEntry.config, projects):expect()
	return HttpService:JSONEncode(result.results or result)
end

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local entries = {}
local gameOutputs = {}

for _, pkgEntry in payload.packages do
	local t0 = os.clock()
	local ok, jestOrError = pcall(runPackage, pkgEntry)
	local elapsedMs = math.floor((os.clock() - t0) * 1000)

	if ok then
		table.insert(entries, {
			pkg = pkgEntry.pkg,
			elapsedMs = elapsedMs,
			jestOutput = jestOrError,
		})
	else
		table.insert(entries, {
			pkg = pkgEntry.pkg,
			elapsedMs = elapsedMs,
			jestOutput = HttpService:JSONEncode({
				success = false,
				err = tostring(jestOrError),
			}),
		})
	end
	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({ entries = entries }), table.concat(gameOutputs, "")
