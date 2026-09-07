--!nocheck
-- Lute-driven test for the Code Bundle rebuild. The module under test is
-- inlined into the placeholder below as a vararg function, so the fake `game`
-- and `Instance` declared here are the upvalues it closes over and the task
-- input arrives the way Open Cloud hands one over. Any failed assertion calls
-- error(), failing the wrapper spec.
--
-- The bundle really is JSON in a buffer here: the module's first act is to read
-- one, and a harness that handed it a table would prove nothing about the
-- buffer. The encoder and decoder below cover exactly what a Code Bundle holds
-- — objects, arrays, strings, numbers and booleans — and nothing else.

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

-- === JSON, as the wire carries it ===

local ESCAPES: { [string]: string } = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local UNESCAPES: { [string]: string } = {
	n = "\n",
	r = "\r",
	t = "\t",
}

local function encodeString(value: string): string
	local escaped = string.gsub(value, '["\\\n\r\t]', function(char)
		return ESCAPES[char]
	end)

	return '"' .. escaped .. '"'
end

-- A table with an array part encodes as an array and any other as an object.
-- An empty one is ambiguous and stays so: a Code Bundle's only empty table is
-- a file mount's entry list, which the rebuild iterates either way.
local function encodeJson(value: any): string
	local kind = type(value)
	if kind == "string" then
		return encodeString(value)
	end

	if kind == "number" or kind == "boolean" then
		return tostring(value)
	end

	check(kind == "table", "json: cannot encode a " .. kind)

	local parts = {}
	if #value > 0 then
		for _, item in value do
			table.insert(parts, encodeJson(item))
		end

		return "[" .. table.concat(parts, ",") .. "]"
	end

	for key, item in value do
		table.insert(parts, encodeString(key) .. ":" .. encodeJson(item))
	end

	return "{" .. table.concat(parts, ",") .. "}"
end

local function decodeJson(text: string): any
	local index = 1

	local function skipSpace()
		local _, stop = string.find(text, "^[ \t\r\n]*", index)
		index = stop + 1
	end

	local function decodeString(): string
		index += 1
		local parts = {}
		while true do
			local char = string.sub(text, index, index)
			check(char ~= "", "json: unterminated string")
			if char == '"' then
				index += 1
				break
			end

			if char ~= "\\" then
				table.insert(parts, char)
				index += 1
				continue
			end

			local escape = string.sub(text, index + 1, index + 1)
			index += 2
			table.insert(parts, UNESCAPES[escape] or escape)
		end

		return table.concat(parts)
	end

	local function decodeValue(): any
		skipSpace()
		local char = string.sub(text, index, index)
		if char == '"' then
			return decodeString()
		end

		if char == "{" then
			index += 1
			local object = {}
			skipSpace()
			if string.sub(text, index, index) == "}" then
				index += 1
				return object
			end

			while true do
				skipSpace()
				local key = decodeString()
				skipSpace()
				check(string.sub(text, index, index) == ":", "json: expected : at " .. index)
				index += 1
				object[key] = decodeValue()
				skipSpace()
				local delimiter = string.sub(text, index, index)
				index += 1
				if delimiter == "}" then
					break
				end

				check(delimiter == ",", "json: expected , or } at " .. index)
			end

			return object
		end

		if char == "[" then
			index += 1
			local array = {}
			skipSpace()
			if string.sub(text, index, index) == "]" then
				index += 1
				return array
			end

			while true do
				table.insert(array, decodeValue())
				skipSpace()
				local delimiter = string.sub(text, index, index)
				index += 1
				if delimiter == "]" then
					break
				end

				check(delimiter == ",", "json: expected , or ] at " .. index)
			end

			return array
		end

		local literal, stop = string.match(text, "^([%w%.%+%-]+)()", index)
		check(literal ~= nil, "json: unexpected character at " .. index)
		index = stop
		if literal == "true" then
			return true
		end

		if literal == "false" then
			return false
		end

		return tonumber(literal)
	end

	return decodeValue()
end

-- === The fake DataModel ===

local state: { [any]: any } = {}
local instanceMeta = {}
local methods = {}

local function newInstance(className: string, name: string)
	local instance = setmetatable({}, instanceMeta)
	state[instance] = {
		children = {},
		fields = {
			ClassName = className,
			Name = name,
			Parent = nil,
		},
	}

	return instance
end

local function setParent(instance, parent)
	local entry = state[instance]
	-- Destroy locks the Parent property, so a rebuild that reaches for
	-- something it already destroyed throws here as it would on a real
	-- DataModel.
	check(entry.destroyed ~= true, "Parent is locked: " .. entry.fields.Name .. " was destroyed")

	local previous = entry.fields.Parent
	if previous ~= nil then
		local siblings = state[previous].children
		for index, sibling in siblings do
			if sibling == instance then
				table.remove(siblings, index)
				break
			end
		end
	end

	entry.fields.Parent = parent
	if parent ~= nil then
		table.insert(state[parent].children, instance)
	end
end

function methods.GetChildren(instance)
	local copy = {}
	for index, child in state[instance].children do
		copy[index] = child
	end

	return copy
end

function methods.FindFirstChild(instance, name: string)
	for _, child in state[instance].children do
		if state[child].fields.Name == name then
			return child
		end
	end

	return nil
end

-- Destroys the whole subtree, which is what the real one does: an instance
-- moved out of a doomed tree survives, and one left in it does not.
function methods.Destroy(instance)
	setParent(instance, nil)
	state[instance].destroyed = true
	for _, child in methods.GetChildren(instance) do
		methods.Destroy(child)
	end
end

local HttpService = {
	JSONDecode = function(_, text: string): any
		return decodeJson(text)
	end,
}

function methods.GetService(instance, name: string)
	if name == "HttpService" then
		return HttpService
	end

	local existing = methods.FindFirstChild(instance, name)
	check(existing ~= nil, "GetService: no such service " .. name)
	return existing
end

instanceMeta.__index = function(instance, key)
	local method = methods[key]
	if method ~= nil then
		return function(_, ...)
			return method(instance, ...)
		end
	end

	return state[instance].fields[key]
end

instanceMeta.__newindex = function(instance, key, value)
	if key == "Parent" then
		setParent(instance, value)
		return
	end

	state[instance].fields[key] = value
end

local game = newInstance("DataModel", "game")

local Instance = {
	new = function(className: string)
		return newInstance(className, className)
	end,
}

-- A DataModel of its own per test, so nothing one test builds reaches the
-- next. The module reads `game` when it runs rather than when it is loaded, so
-- reassigning the upvalue is enough.
local function resetGame()
	game = newInstance("DataModel", "game")
	for _, serviceName in { "ReplicatedStorage", "ServerStorage" } do
		setParent(newInstance(serviceName, serviceName), game)
	end
end

local rebuild = __MODULE__

local function service(name: string)
	return methods.GetService(game, name)
end

-- Builds the tree a Harness Place would have booted with, returning the
-- deepest folder so a test can fill it.
local function makeFolders(parent, ...)
	local cursor = parent
	for _, name in { ... } do
		cursor = newInstance("Folder", name)
		setParent(cursor, parent)
		parent = cursor
	end

	return cursor
end

local function addChild(parent, className: string, name: string, source: string?)
	local instance = newInstance(className, name)
	if source ~= nil then
		state[instance].fields.Source = source
	end

	setParent(instance, parent)
	return instance
end

local function runRebuild(bundle)
	rebuild({ BinaryInput = buffer.fromstring(encodeJson(bundle)) })
end

-- T1: a merging mount keeps the harness instance, so an explicit child the
-- place still serves survives, while the loose file the bundle carries is
-- replaced rather than duplicated.
local function testMergeKeepsPlaceServedChild()
	resetGame()
	local rbxts = makeFolders(service("ReplicatedStorage"), "rbxts")
	local out = addChild(rbxts, "Folder", "out")
	local served = addChild(out, "Folder", "shared")
	local stale = addChild(out, "ModuleScript", "loose", "return 'stale'")

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out" },
				entries = {
					{ className = "ModuleScript", path = "loose", source = "return 'fresh'" },
				},
				merge = true,
				root = { className = "Folder" },
			},
		},
		version = 1,
	})

	check(rbxts:FindFirstChild("out") == out, "T1: the merging mount kept the harness instance")
	check(out:FindFirstChild("shared") == served, "T1: and the child the place serves")
	local loose = out:FindFirstChild("loose")
	check(loose ~= nil and loose ~= stale, "T1: the loose file was replaced")
	check(loose.Source == "return 'fresh'", "T1: with the bundle's source")
	check(#out:GetChildren() == 2, "T1: leaving no duplicate behind")
end

-- T2: a plain mount is exactly its directory, so what the place held under that
-- name goes whole and a test file deleted since the harness was built cannot
-- outlive its build.
local function testPlainMountIsReplacedWhole()
	resetGame()
	local rbxts = makeFolders(service("ReplicatedStorage"), "rbxts")
	local out = addChild(rbxts, "Folder", "out")
	addChild(out, "ModuleScript", "gone", "return 'gone'")

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out" },
				entries = {
					{ className = "ModuleScript", path = "kept", source = "return 'kept'" },
				},
				merge = false,
				root = { className = "Folder" },
			},
		},
		version = 1,
	})

	local rebuilt = rbxts:FindFirstChild("out")
	check(rebuilt ~= nil and rebuilt ~= out, "T2: the plain mount was replaced whole")
	check(rebuilt:FindFirstChild("gone") == nil, "T2: the stale child is gone")
	check(rebuilt:FindFirstChild("kept") ~= nil, "T2: and the bundle's entry is there")
end

-- T3: a mount rojo promotes to a ModuleScript over a harness Folder — the
-- coverage-demoted case — rebuilds the root and re-parents what the place was
-- serving under it, so `WaitForChild` still finds it.
local function testClassChangedRootInheritsChildren()
	resetGame()
	local stage = makeFolders(service("ServerStorage"), "__pkg_stage", "pkg")
	local out = addChild(stage, "Folder", "out")
	local survivor = addChild(out, "Folder", "shared")

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ServerStorage", "__pkg_stage", "pkg", "out" },
				entries = {},
				merge = true,
				root = { className = "ModuleScript", source = "return 'init'" },
			},
		},
		version = 1,
	})

	local rebuilt = stage:FindFirstChild("out")
	check(rebuilt ~= nil and rebuilt ~= out, "T3: the root whose class changed was rebuilt")
	check(rebuilt.ClassName == "ModuleScript", "T3: to the class the bundle names")
	check(rebuilt.Source == "return 'init'", "T3: carrying its source")
	check(rebuilt:FindFirstChild("shared") == survivor, "T3: with the survivor re-parented")
	check(#stage:GetChildren() == 1, "T3: and the instance it replaced destroyed")
end

-- T4: a merging mount whose class is unchanged is the harness instance itself,
-- source and all, so a project that declares children beside an
-- `init.luau` mount keeps them.
local function testMergeOverSameClassUpdatesSource()
	resetGame()
	local rbxts = makeFolders(service("ReplicatedStorage"), "rbxts")
	local out = addChild(rbxts, "ModuleScript", "out", "return 'stale'")
	local served = addChild(out, "Folder", "shared")

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out" },
				entries = {},
				merge = true,
				root = { className = "ModuleScript", source = "return 'fresh'" },
			},
		},
		version = 1,
	})

	check(rbxts:FindFirstChild("out") == out, "T4: the merging mount kept the harness instance")
	check(out.Source == "return 'fresh'", "T4: and took the bundle's source")
	check(out:FindFirstChild("shared") == served, "T4: leaving its children alone")
end

-- T5: a single file travels as the one script it is, and lands under the
-- directory mount above it because mounts arrive shallowest first.
local function testFileMountLandsUnderItsDirectoryMount()
	resetGame()
	local rbxts = makeFolders(service("ReplicatedStorage"), "rbxts")
	addChild(rbxts, "Folder", "out")

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out" },
				entries = {
					{ className = "ModuleScript", path = "index", source = "return 1" },
				},
				merge = false,
				root = { className = "Folder" },
			},
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out", "jest.config" },
				entries = {},
				merge = false,
				root = { className = "ModuleScript", source = "return { testMatch = {} }" },
			},
		},
		version = 1,
	})

	local out = rbxts:FindFirstChild("out")
	local config = out:FindFirstChild("jest.config")
	check(config ~= nil, "T5: the file mount landed under the directory mount")
	check(config.ClassName == "ModuleScript", "T5: as the one script it is")
	check(config.Source == "return { testMatch = {} }", "T5: carrying its source")
	check(out:FindFirstChild("index") ~= nil, "T5: beside the directory mount's own entry")
end

-- T6: a nested mount is rebuilt after the mount it sits under rather than
-- being wiped by it, and entries arrive shallowest first so an
-- `init`-promoted directory exists as a ModuleScript before its descendants.
local function testNestedMountSurvivesTheMountAboveIt()
	resetGame()
	local rbxts = makeFolders(service("ReplicatedStorage"), "rbxts")
	addChild(rbxts, "Folder", "out")

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out" },
				entries = {
					{ className = "ModuleScript", path = "example", source = "return 'init'" },
					{ className = "ModuleScript", path = "example/test.spec", source = "return 2" },
				},
				merge = false,
				root = { className = "Folder" },
			},
			{
				dataModelPath = { "ReplicatedStorage", "rbxts", "out", "nested" },
				entries = {
					{ className = "ModuleScript", path = "deep", source = "return 3" },
				},
				merge = false,
				root = { className = "Folder" },
			},
		},
		version = 1,
	})

	local out = rbxts:FindFirstChild("out")
	local example = out:FindFirstChild("example")
	check(example ~= nil, "T6: the init-promoted directory was created")
	check(example.ClassName == "ModuleScript", "T6: as a ModuleScript")
	check(example:FindFirstChild("test.spec") ~= nil, "T6: holding the entry beneath it")

	local nested = out:FindFirstChild("nested")
	check(nested ~= nil, "T6: the nested mount survived the mount above it")
	check(nested:FindFirstChild("deep") ~= nil, "T6: with its own entries")
end

-- T7: a mount whose ancestors the harness place never held is reached through
-- Folders the rebuild makes, so a package stage the split hollowed out is
-- rebuilt rather than dropped.
local function testMissingAncestorsBecomeFolders()
	resetGame()

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ServerStorage", "__pkg_stage", "pkg", "out" },
				entries = {
					{ className = "ModuleScript", path = "index", source = "return 1" },
				},
				merge = true,
				root = { className = "Folder" },
			},
		},
		version = 1,
	})

	local stage = service("ServerStorage"):FindFirstChild("__pkg_stage")
	check(stage ~= nil, "T7: the missing ancestor was created")
	check(stage.ClassName == "Folder", "T7: as a Folder")
	local package = stage:FindFirstChild("pkg")
	check(package ~= nil and package.ClassName == "Folder", "T7: and so was the one below it")
	local out = package:FindFirstChild("out")
	check(out ~= nil, "T7: with the mount root under them")
	check(out:FindFirstChild("index") ~= nil, "T7: holding the bundle's entries")
end

-- T8: a segment holding a slash is one instance name, not two. A workspace
-- stage node is named after its package, so a scoped package's stage is
-- literally `@scope/pkg`; joined into a string the mount travels as one path
-- and the rebuild built `@scope` -> `pkg` instead, leaving the stage the
-- materializer clones from empty.
local function testSlashInASegmentIsOneName()
	resetGame()

	runRebuild({
		mounts = {
			{
				dataModelPath = { "ServerStorage", "__pkg_stage", "@scope/pkg", "out" },
				entries = {
					{ className = "ModuleScript", path = "index", source = "return 1" },
				},
				merge = true,
				root = { className = "Folder" },
			},
		},
		version = 1,
	})

	local stage = service("ServerStorage"):FindFirstChild("__pkg_stage")
	check(stage ~= nil, "T8: the stage was created")
	check(stage:FindFirstChild("@scope") == nil, "T8: and the slash split no folder off it")
	local package = stage:FindFirstChild("@scope/pkg")
	check(package ~= nil, "T8: the scoped name landed as one instance")
	local out = package:FindFirstChild("out")
	check(out ~= nil, "T8: with the mount root under it")
	check(out:FindFirstChild("index") ~= nil, "T8: holding the bundle's entries")
end

-- T9: a bundle a task cannot read is refused by name, before anything is
-- rebuilt — a DataModel half rebuilt by rules the task guessed at is worse
-- than one the run never touched. The message carries both versions because
-- either half alone leaves the reader guessing which side is behind.
local function testUnknownVersionIsRefused()
	resetGame()

	local ok, message = pcall(runRebuild, {
		mounts = {
			{
				dataModelPath = { "ReplicatedStorage", "rbxts" },
				entries = {},
				merge = false,
				root = { className = "Folder" },
			},
		},
		version = 2,
	})

	check(not ok, "T9: an unknown bundle version was refused")
	check(
		service("ReplicatedStorage"):FindFirstChild("rbxts") == nil,
		"T9: before any mount was rebuilt"
	)
	check(
		string.find(message, "version 2", 1, true) ~= nil,
		"T9: naming the version the bundle carries, got: " .. tostring(message)
	)
	check(
		string.find(message, "version 1", 1, true) ~= nil,
		"T9: and the one the task supports, got: " .. tostring(message)
	)
end

testMergeKeepsPlaceServedChild()
testPlainMountIsReplacedWhole()
testClassChangedRootInheritsChildren()
testMergeOverSameClassUpdatesSource()
testFileMountLandsUnderItsDirectoryMount()
testNestedMountSurvivesTheMountAboveIt()
testMissingAncestorsBecomeFolders()
testSlashInASegmentIsOneName()
testUnknownVersionIsRefused()

print("ALL OK")
