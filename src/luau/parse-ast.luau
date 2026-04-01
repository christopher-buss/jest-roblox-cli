local fs = require("@std/fs")
local json = require("@std/json")
local process = require("@std/process")
local syntax = require("@std/syntax")

local rawArgs = process.args
local userArgs: { string } = {}
local pastSeparator = false

for _, arg in rawArgs do
	if pastSeparator then
		table.insert(userArgs, arg)
	elseif arg == "--" then
		pastSeparator = true
	end
end

local luauRoot = userArgs[1]
if not luauRoot then
	error("Usage: lute run parse-ast.luau -- <file.luau | luau-root> [output-dir]")
end

luauRoot = string.gsub(luauRoot, "\\", "/")

-- Fields to keep per AST tag (beyond tag/kind/location which are always kept).
-- Tags shared by stat/expr variants are merged — nil fields are harmless.
local KEEP: { [string]: { string } } = {
	assign = { "values", "variables" },
	binary = { "lhsOperand", "rhsOperand" },
	block = { "statements" },
	boolean = { "value" },
	call = { "arguments", "func" },
	cast = { "operand" },
	compoundassign = { "value", "variable" },
	conditional = { "condition", "thenBlock", "elseifs", "elseBlock", "thenExpr", "elseExpr" },
	["do"] = { "body" },
	expression = { "expression" },
	["for"] = { "body", "from", "to", "step" },
	forin = { "body", "values" },
	["function"] = { "body", "name", "func" },
	global = { "name" },
	group = { "expression" },
	index = { "expression", "index" },
	indexname = { "expression", "accessor", "index" },
	instantiate = { "expr" },
	interpolatedstring = { "expressions" },
	["local"] = { "values", "variables" },
	localfunction = { "name", "func" },
	number = { "value" },
	["repeat"] = { "body", "condition" },
	["return"] = { "expressions" },
	string = { "text" },
	table = { "entries" },
	unary = { "operand" },
	["while"] = { "body", "condition" },
}

local function strip(value: any): any
	if type(value) ~= "table" then
		return value
	end

	-- LuauSpan — has beginLine, no tag
	if value.beginLine ~= nil then
		return value
	end

	-- Token — has text but no tag, reduce to {text}
	if value.text ~= nil and value.tag == nil then
		return { text = value.text }
	end

	-- AST node — has tag, keep only allowlisted fields
	if value.tag ~= nil then
		local result = { tag = value.tag, kind = value.kind, location = value.location }
		local fields = KEEP[value.tag :: string]
		if fields then
			for _, field in fields do
				if value[field] ~= nil then
					result[field] = strip(value[field])
				end
			end
		end

		return result
	end

	-- Other tables (arrays, Pairs, ElseIf structs) — recurse all fields
	local result: any = {}
	for k, v in value do
		result[k] = strip(v)
	end

	return result
end

-- Single-file mode: parse one file, print stripped AST to stdout
if string.sub(luauRoot, -5) == ".luau" or string.sub(luauRoot, -4) == ".lua" then
	local source = fs.readfiletostring(luauRoot)
	local parseResult = syntax.parse(source)
	print(json.serialize(strip(parseResult.root)))
	return
end

local outputDir = userArgs[2]
if not outputDir then
	error("Usage: lute run parse-ast.luau -- <luau-root> <output-dir>")
end

outputDir = string.gsub(outputDir, "\\", "/")

-- Discover .luau files recursively, skipping node_modules, dot dirs, spec/test files
local function discoverFiles(directory: string, relativeTo: string, results: { string })
	local entries = fs.listdirectory(directory)
	for _, entry in entries do
		local fullPath = directory .. "/" .. entry.name
		if entry.type == "dir" then
			if entry.name == "node_modules" or entry.name == ".jest-roblox-coverage" then
				continue
			end

			if string.sub(entry.name, 1, 1) == "." then
				continue
			end

			discoverFiles(fullPath, relativeTo, results)
		elseif
			entry.type == "file"
			and (string.sub(entry.name, -5) == ".luau" or string.sub(entry.name, -4) == ".lua")
		then
			if
				string.sub(entry.name, -10) == ".spec.luau"
				or string.sub(entry.name, -10) == ".test.luau"
				or string.sub(entry.name, -9) == ".spec.lua"
				or string.sub(entry.name, -9) == ".test.lua"
				or string.sub(entry.name, -10) == ".snap.luau"
				or string.sub(entry.name, -9) == ".snap.lua"
			then
				continue
			end

			-- Compute relative path
			local relative = string.sub(fullPath, #relativeTo + 2)
			table.insert(results, relative)
		end
	end
end

local function dirname(filepath: string): string
	local pos = string.find(filepath, "/[^/]*$")
	if pos then
		return string.sub(filepath, 1, pos - 1)
	end

	return ""
end

-- Optional 3rd arg: path to skip list JSON file.
-- Skipped files are still included in the file list but not parsed.
local skipListPath = userArgs[3]
local skipSet: { [string]: boolean } = {}
if skipListPath then
	local skipJson = fs.readfiletostring(skipListPath)
	local skipList = json.deserialize(skipJson) :: { string }
	for _, entry in skipList do
		skipSet[entry] = true
	end
end

local files: { string } = {}
discoverFiles(luauRoot, luauRoot, files)

-- Parse, strip, and write per-file AST JSON
for _, relativePath in files do
	if skipSet[relativePath] then
		continue
	end

	local fullPath = luauRoot .. "/" .. relativePath
	local source = fs.readfiletostring(fullPath)
	local parseResult = syntax.parse(source)
	local stripped = strip(parseResult.root)

	local outPath = outputDir .. "/" .. relativePath .. ".json"
	local dir = dirname(outPath)
	if dir ~= "" then
		fs.createdirectory(dir, { makeparents = true })
	end

	fs.writestringtofile(outPath, json.serialize(stripped))
end

-- Print file list to stdout (tiny — just paths)
print(json.serialize(files :: json.array))
