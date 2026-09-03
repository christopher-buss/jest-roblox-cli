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

function methods.GetFullName(instance)
	local segments = {}
	local cursor = instance
	while cursor ~= nil and state[cursor].fields.ClassName ~= "DataModel" do
		table.insert(segments, 1, state[cursor].fields.Name)
		cursor = state[cursor].fields.Parent
	end

	return table.concat(segments, ".")
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

-- A package stages as `__pkg_stage/<pkg>/<live service name>/…`, which is the
-- layout `materialize` walks. Returns the staged ReplicatedStorage to fill.
local function stagePackage(pkgName: string, runContextScripts: boolean?)
	local staged = newInstance("Folder", pkgName)
	if runContextScripts then
		methods.SetAttribute(staged, "JestRunContextScripts", true)
	end

	setParent(staged, stage)

	local stagedService = newInstance("Folder", "ReplicatedStorage")
	setParent(stagedService, staged)

	return stagedService
end

local function stageDeepPackage(pkgName: string, runContextScripts: boolean)
	local stagedService = stagePackage(pkgName, runContextScripts)

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

-- T5: a collision the Folder/Model merge does not cover is found before
-- anything is parented, so a failed materialize leaves nothing live behind it
-- — not even the siblings staged ahead of the collision.
local function testCollisionMaterializesNothing()
	local liveModule = newInstance("ModuleScript", "Shared")
	setParent(liveModule, ReplicatedStorage)

	local stagedService = stagePackage("collide")
	setParent(newInstance("Folder", "Before"), stagedService)
	setParent(newInstance("ModuleScript", "Shared"), stagedService)

	local ok, message = pcall(function()
		Materializer.materialize("collide")
	end)

	check(not ok, "T5: a collision with no merge rule must error")
	check(
		string.find(tostring(message), "ReplicatedStorage.Shared", 1, true) ~= nil,
		"T5: the message names the colliding instance, got: " .. tostring(message)
	)
	check(
		methods.FindFirstChild(ReplicatedStorage, "Before") == nil,
		"T5: the sibling staged ahead of the collision never lands"
	)
	check(
		#methods.GetChildren(ReplicatedStorage) == 1
			and methods.FindFirstChild(ReplicatedStorage, "Shared") == liveModule,
		"T5: the live instance is the only child left, and it is the original"
	)

	setParent(liveModule, nil)
end

-- T6: a container on one side only is still a collision, not a merge — a
-- Folder cannot absorb a ModuleScript's children, and a ModuleScript has none
-- to absorb.
local function testMixedContainerCollisionErrors(liveClass: string, stagedClass: string)
	local live = newInstance(liveClass, "Mixed")
	setParent(live, ReplicatedStorage)

	local pkgName = "mixed-" .. liveClass .. "-" .. stagedClass
	local stagedService = stagePackage(pkgName)
	setParent(newInstance(stagedClass, "Mixed"), stagedService)

	local ok = pcall(function()
		Materializer.materialize(pkgName)
	end)

	check(not ok, string.format("T6: staged %s over live %s must error", stagedClass, liveClass))
	check(
		methods.FindFirstChild(ReplicatedStorage, "Mixed") == live,
		string.format("T6: live %s left in place", liveClass)
	)

	setParent(live, nil)
end

-- T7: every collision is reported together. A retry costs a place upload and
-- the cold boot behind it, so a package with two collisions must not cost two
-- round trips to find out.
local function testAllCollisionsReportedTogether()
	local first = newInstance("ModuleScript", "First")
	local second = newInstance("Script", "Second")
	setParent(first, ReplicatedStorage)
	setParent(second, ReplicatedStorage)

	local stagedService = stagePackage("two-collisions")
	setParent(newInstance("Folder", "First"), stagedService)
	setParent(newInstance("ModuleScript", "Second"), stagedService)

	local ok, message = pcall(function()
		Materializer.materialize("two-collisions")
	end)

	check(not ok, "T7: two collisions must error")
	-- Both class names, and each on the side it belongs to: a message that
	-- reads "staged ModuleScript over live Folder" sends the reader to fix the
	-- wrong tree.
	check(
		string.find(tostring(message), "ReplicatedStorage.First: staged Folder over live ModuleScript", 1, true)
			~= nil,
		"T7: the message names the first collision, got: " .. tostring(message)
	)
	check(
		string.find(tostring(message), "ReplicatedStorage.Second: staged ModuleScript over live Script", 1, true)
			~= nil,
		"T7: the message names the second collision, got: " .. tostring(message)
	)

	setParent(first, nil)
	setParent(second, nil)
end

-- T10: two containers of one name merge, which is the whole reason the
-- collision rule has an exception. The live folder keeps what it held, gains
-- what the package staged, and reset takes back only what the package added.
local function testContainersMerge()
	local liveShared = newInstance("Folder", "Shared")
	setParent(liveShared, ReplicatedStorage)
	local liveChild = newInstance("ModuleScript", "Existing")
	setParent(liveChild, liveShared)

	local stagedService = stagePackage("merge")
	local stagedShared = newInstance("Folder", "Shared")
	setParent(stagedShared, stagedService)
	setParent(newInstance("ModuleScript", "Added"), stagedShared)

	Materializer.materialize("merge")

	check(
		methods.FindFirstChild(ReplicatedStorage, "Shared") == liveShared,
		"T10: the live folder is merged into, not replaced"
	)
	check(
		methods.FindFirstChild(liveShared, "Existing") == liveChild,
		"T10: what the live folder held is untouched"
	)
	check(methods.FindFirstChild(liveShared, "Added") ~= nil, "T10: the staged child landed inside")

	Materializer.reset()

	check(
		methods.FindFirstChild(liveShared, "Added") == nil,
		"T10: reset takes back only what the package added"
	)
	check(
		methods.FindFirstChild(liveShared, "Existing") == liveChild,
		"T10: reset leaves the live folder and its own children in place"
	)

	setParent(liveShared, nil)
end

-- T9: a name under one destination belongs to one instance, so two staged
-- children of that name collide with each other. Deciding every landing site
-- up front is what makes this reachable: both see a free name in the live
-- service, because neither has been parented yet.
local function testStagedSiblingsCollide()
	local stagedService = stagePackage("staged-twins")
	setParent(newInstance("ModuleScript", "Twin"), stagedService)
	setParent(newInstance("Folder", "Twin"), stagedService)

	local ok, message = pcall(function()
		Materializer.materialize("staged-twins")
	end)

	check(not ok, "T9: two staged children of one name must error")
	check(
		string.find(tostring(message), "ReplicatedStorage.Twin: staged Folder over staged ModuleScript", 1, true)
			~= nil,
		"T9: the message names the contested name and both stagings, got: " .. tostring(message)
	)
	check(
		#methods.GetChildren(ReplicatedStorage) == 0,
		"T9: neither staged child lands"
	)
end

-- T8: a package whose whole stage is one ModuleScript goes to
-- ReplicatedStorage under the same collision rule as any other staged child.
local function testModuleScriptStageRoot()
	local staged = newInstance("ModuleScript", "solo")
	setParent(staged, stage)

	Materializer.materialize("solo")

	local materialized = methods.FindFirstChild(ReplicatedStorage, "solo")
	check(materialized ~= nil, "T8: a ModuleScript stage root materializes")
	check(materialized ~= staged, "T8: the staged copy stays on the stage")

	Materializer.reset()
	check(
		methods.FindFirstChild(ReplicatedStorage, "solo") == nil,
		"T8: reset removes it again"
	)

	local live = newInstance("Folder", "solo")
	setParent(live, ReplicatedStorage)

	local ok = pcall(function()
		Materializer.materialize("solo")
	end)

	check(not ok, "T8: a ModuleScript stage root that collides must error too")
	check(
		methods.FindFirstChild(ReplicatedStorage, "solo") == live,
		"T8: the live instance is left alone"
	)

	setParent(live, nil)
	setParent(staged, nil)
end

testRestoreRunContextIsLinear()
testRestoreRunContextReachesEveryDepth()
testResetClearsMaterialized()
testWithoutRunContextAttribute()
testCollisionMaterializesNothing()
testMixedContainerCollisionErrors("ModuleScript", "Folder")
testMixedContainerCollisionErrors("Folder", "ModuleScript")
testAllCollisionsReportedTogether()
testContainersMerge()
testStagedSiblingsCollide()
testModuleScriptStageRoot()

print("ALL OK")
