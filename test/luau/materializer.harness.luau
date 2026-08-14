--!nocheck
-- Lute-driven test for the workspace materializer. The module under test is
-- inlined into the placeholder below by materializer.spec.ts, so the fake
-- `game` / `Enum` declared here are the upvalues it closes over. Any failed
-- assertion calls error(), failing the wrapper spec.
--
-- The fake DataModel counts GetDescendants calls, which is what pins the
-- run-context restore to a linear walk: the staged tree is one deep chain, so
-- a walk that recurses into each descendant of each descendant costs
-- 2^depth calls and blows the engine's non-yielding script timeout on a real
-- game-sized package.

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

local Enum = {
	RunContext = {
		Legacy = { Name = "Legacy" },
		Server = { Name = "Server" },
	},
}

-- LocalScript deliberately does NOT inherit Script — that is the real class
-- hierarchy, and the materializer relies on it to skip client scripts.
local SUPERCLASS: { [string]: string } = {
	BaseScript = "LuaSourceContainer",
	Folder = "Instance",
	LocalScript = "BaseScript",
	LuaSourceContainer = "Instance",
	Model = "Instance",
	ModuleScript = "LuaSourceContainer",
	Script = "BaseScript",
}

local getDescendantsCalls = 0

local state: { [any]: any } = {}
local instanceMeta = {}
local methods = {}

local function newInstance(className: string, name: string)
	local instance = setmetatable({}, instanceMeta)
	state[instance] = {
		attributes = {},
		children = {},
		fields = {
			ClassName = className,
			Name = name,
			Parent = nil,
			RunContext = Enum.RunContext.Legacy,
		},
	}

	return instance
end

local function setParent(instance, parent)
	local entry = state[instance]
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

local function collectDescendants(instance, into)
	for _, child in state[instance].children do
		table.insert(into, child)
		collectDescendants(child, into)
	end
end

function methods.GetDescendants(instance)
	getDescendantsCalls += 1
	local collected = {}
	collectDescendants(instance, collected)
	return collected
end

function methods.FindFirstChild(instance, name: string)
	for _, child in state[instance].children do
		if state[child].fields.Name == name then
			return child
		end
	end

	return nil
end

function methods.IsA(instance, className: string)
	local current = state[instance].fields.ClassName
	while current ~= nil do
		if current == className then
			return true
		end

		current = SUPERCLASS[current]
	end

	return false
end

function methods.Clone(instance)
	local entry = state[instance]
	local copy = newInstance(entry.fields.ClassName, entry.fields.Name)
	state[copy].fields.RunContext = entry.fields.RunContext
	for key, value in entry.attributes do
		state[copy].attributes[key] = value
	end

	for _, child in entry.children do
		setParent(methods.Clone(child), copy)
	end

	return copy
end

function methods.Destroy(instance)
	setParent(instance, nil)
	state[instance].destroyed = true
end

function methods.GetAttribute(instance, key: string)
	return state[instance].attributes[key]
end

function methods.SetAttribute(instance, key: string, value: any)
	state[instance].attributes[key] = value
end

function methods.GetService(instance, name: string)
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
for _, serviceName in
	{ "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterPlayer" }
do
	setParent(newInstance(serviceName, serviceName), game)
end

local StarterPlayer = methods.FindFirstChild(game, "StarterPlayer")
setParent(newInstance("StarterPlayerScripts", "StarterPlayerScripts"), StarterPlayer)

local Materializer = __MODULE__

local ServerStorage = methods.FindFirstChild(game, "ServerStorage")
local ReplicatedStorage = methods.FindFirstChild(game, "ReplicatedStorage")
local stage = newInstance("Folder", "__pkg_stage")
setParent(stage, ServerStorage)

-- One deep chain. `restoreRunContext` recursing into every descendant of every
-- descendant costs 2^(DEPTH-1) calls here; a single pass costs one.
local DEPTH = 14

local function stageDeepPackage(pkgName: string, runContextScripts: boolean)
	local staged = newInstance("Folder", pkgName)
	if runContextScripts then
		methods.SetAttribute(staged, "JestRunContextScripts", true)
	end

	setParent(staged, stage)

	local stagedService = newInstance("Folder", "ReplicatedStorage")
	setParent(stagedService, staged)

	local nodeCount = 0
	local cursor = newInstance("Folder", "chain")
	nodeCount += 1
	setParent(cursor, stagedService)

	for level = 2, DEPTH do
		local child = newInstance("Folder", "level" .. level)
		nodeCount += 1
		setParent(child, cursor)
		cursor = child
	end

	local serverScript = newInstance("Script", "deepServer")
	nodeCount += 1
	setParent(serverScript, cursor)

	local localScript = newInstance("LocalScript", "deepClient")
	nodeCount += 1
	setParent(localScript, cursor)

	local moduleScript = newInstance("ModuleScript", "deepModule")
	nodeCount += 1
	setParent(moduleScript, cursor)

	return nodeCount
end

-- T1: restoring run context walks the staged tree once per instance. A
-- superlinear walk is the workspace-mode script timeout on a large package.
local function testRestoreRunContextIsLinear()
	local nodeCount = stageDeepPackage("deep", true)

	getDescendantsCalls = 0
	Materializer.materialize("deep")

	check(
		getDescendantsCalls <= nodeCount,
		string.format(
			"T1: run-context restore must visit the staged tree linearly, but made %d GetDescendants calls for %d instances",
			getDescendantsCalls,
			nodeCount
		)
	)
end

-- T2: the walk still restores every Script at any depth, leaves LocalScripts
-- alone (a LocalScript cannot hold RunContext = Server), and leaves
-- ModuleScripts alone.
local function testRestoreRunContextReachesEveryDepth()
	local cursor = methods.FindFirstChild(ReplicatedStorage, "chain")
	check(cursor ~= nil, "T2: chain materialized into ReplicatedStorage")

	for level = 2, DEPTH do
		cursor = methods.FindFirstChild(cursor, "level" .. level)
		check(cursor ~= nil, "T2: chain reaches level" .. level)
	end

	local serverScript = methods.FindFirstChild(cursor, "deepServer")
	check(serverScript ~= nil, "T2: deep Script materialized")
	check(
		serverScript.RunContext == Enum.RunContext.Server,
		"T2: deep Script restored to RunContext.Server"
	)

	local localScript = methods.FindFirstChild(cursor, "deepClient")
	check(localScript ~= nil, "T2: deep LocalScript materialized")
	check(localScript.RunContext == Enum.RunContext.Legacy, "T2: deep LocalScript left legacy")

	local moduleScript = methods.FindFirstChild(cursor, "deepModule")
	check(moduleScript ~= nil, "T2: deep ModuleScript materialized")
	check(moduleScript.RunContext == Enum.RunContext.Legacy, "T2: deep ModuleScript left legacy")
end

-- T3: reset removes everything the run materialized, leaving the live service
-- as it was before.
local function testResetClearsMaterialized()
	Materializer.reset()

	check(
		methods.FindFirstChild(ReplicatedStorage, "chain") == nil,
		"T3: reset removed the materialized chain"
	)
	check(#methods.GetChildren(ReplicatedStorage) == 0, "T3: live service left empty")
end

-- T4: a package that did not ask for run-context scripts leaves its Scripts
-- legacy, and still walks linearly.
local function testWithoutRunContextAttribute()
	local nodeCount = stageDeepPackage("legacy", false)

	getDescendantsCalls = 0
	Materializer.materialize("legacy")

	check(
		getDescendantsCalls <= nodeCount,
		string.format(
			"T4: legacy-script package must walk linearly, but made %d GetDescendants calls for %d instances",
			getDescendantsCalls,
			nodeCount
		)
	)

	local cursor = methods.FindFirstChild(ReplicatedStorage, "chain")
	for level = 2, DEPTH do
		cursor = methods.FindFirstChild(cursor, "level" .. level)
	end

	local serverScript = methods.FindFirstChild(cursor, "deepServer")
	check(
		serverScript.RunContext == Enum.RunContext.Legacy,
		"T4: Script left legacy when the package did not opt in"
	)

	Materializer.reset()
end

testRestoreRunContextIsLinear()
testRestoreRunContextReachesEveryDepth()
testResetClearsMaterialized()
testWithoutRunContextAttribute()

print("ALL OK")
