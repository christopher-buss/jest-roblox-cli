--!nocheck
local function check(condition: boolean, message: string)
	if not condition then
		error(message, 0)
	end
end

local function makeInstance(name: string, children: { [string]: any }?)
	return {
		Name = name,
		FindFirstChild = function(_self, child: string)
			return if children then children[child] else nil
		end,
	}
end

local function makeRegistry(entries: { [any]: any })
	return {
		get = function(_self, key)
			return entries[key]
		end,
		clear = function(_self)
			table.clear(entries)
		end,
	}
end

local CircusTypes = makeInstance("types")
local CircusModule =
	makeInstance("JestCircus", { circus = makeInstance("circus", { types = CircusTypes }) })
local JestModule = makeInstance("Jest")

local current

local function makeJest()
	local jest = { teardowns = {} }
	jest.runtimeModule = makeInstance("JestRuntime")
	jest.packages = { JestCircus = CircusModule, JestRuntime = jest.runtimeModule }
	jest.runtimeClass = {
		teardown = function(self, ...)
			self._internalModuleRegistry:clear()
			table.insert(jest.teardowns, { self = self, argumentCount = select("#", ...) })
			return "torn down"
		end,
	}
	current = jest
	return jest
end

local function require(target)
	if target == "./instance-resolver" then
		return {
			findSiblingPackage = function(_jestModule, name: string)
				return current.packages[name]
			end,
			findCircusModule = function(circusPackage, name: string)
				local circus = circusPackage:FindFirstChild("circus")
				return if circus then circus:FindFirstChild(name) else nil
			end,
		}
	end

	if target == current.runtimeModule then
		return current.runtimeClass
	end

	error("unstubbed require: " .. tostring(target), 0)
end

local fakeGlobals = {}

local CircusStateRelease = __MODULE__

local function makeRuntime(entries)
	return { _internalModuleRegistry = makeRegistry(entries) }
end

do
	local jest = makeJest()
	CircusStateRelease.patch(JestModule)

	local stateSymbol = newproxy()
	local otherSymbol = newproxy()
	fakeGlobals[stateSymbol] = { rootDescribeBlock = {} }
	fakeGlobals[otherSymbol] = true
	local runtime = makeRuntime({ [CircusTypes] = { exports = { STATE_SYM = stateSymbol } } })

	local result = jest.runtimeClass.teardown(runtime, 1, 2)

	check(fakeGlobals[stateSymbol] == nil, "T1: the file's circus state is released")
	check(fakeGlobals[otherSymbol] == true, "T1: other globals stay")
	check(result == "torn down", "T1: Jest's teardown result passes through")
	check(
		#jest.teardowns == 1 and jest.teardowns[1].self == runtime,
		"T1: Jest's teardown runs once"
	)
	check(jest.teardowns[1].argumentCount == 2, "T1: Jest's teardown gets its arguments")
	fakeGlobals[otherSymbol] = nil
end

do
	local jest = makeJest()
	CircusStateRelease.patch(JestModule)
	local symbol = newproxy()
	fakeGlobals[symbol] = true

	jest.runtimeClass.teardown(makeRuntime({}))

	check(fakeGlobals[symbol] == true, "T2: globals stay when circus never loaded")
	check(#jest.teardowns == 1, "T2: Jest's teardown still runs")
	fakeGlobals[symbol] = nil
end

do
	local jest = makeJest()
	CircusStateRelease.patch(JestModule)
	local wrapped = jest.runtimeClass.teardown

	CircusStateRelease.patch(JestModule)

	check(jest.runtimeClass.teardown == wrapped, "T3: a second patch keeps the one wrapper")
end

do
	local jest = makeJest()
	jest.packages.JestCircus = nil
	local original = jest.runtimeClass.teardown

	CircusStateRelease.patch(JestModule)

	check(jest.runtimeClass.teardown == original, "T4: no circus leaves teardown alone")
end

do
	local jest = makeJest()
	CircusStateRelease.patch(JestModule)
	local runtime = makeRuntime({ [CircusTypes] = { exports = {} } })

	local success, failure = pcall(jest.runtimeClass.teardown, runtime)

	check(not success, "T5: a circus/types without STATE_SYM fails the teardown")
	check(
		string.find(tostring(failure), "STATE_SYM", 1, true) ~= nil,
		"T5: the failure names STATE_SYM"
	)
end

print("ALL OK")
