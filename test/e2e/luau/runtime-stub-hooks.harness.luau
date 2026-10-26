--!nocheck

local function fail(message: string)
	error(message, 0)
end

local function check(condition: boolean, message: string)
	if not condition then
		fail(message)
	end
end

local function makeInstance(name: string, parent: any): any
	local instance = { Name = name, children = {}, isFakeInstance = true }

	function instance.FindFirstChild(self, childName)
		return self.children[childName]
	end

	function instance.Destroy(self)
		if self.Parent ~= nil then
			self.Parent.children[self.Name] = nil
			self.Parent = nil
		end
	end

	setmetatable(instance, {
		__newindex = function(self, key, value)
			if key == "Parent" then
				rawset(self, "parentRef", value)
				if value ~= nil then
					value.children[self.Name] = self
				end
				return
			end
			rawset(self, key, value)
		end,
		__index = function(self, key)
			if key == "Parent" then
				return rawget(self, "parentRef")
			end
			return nil
		end,
	})
	if parent ~= nil then
		instance.Parent = parent
	end

	return instance
end

local replicatedStorage

local function makeTree(): (any, any)
	replicatedStorage = makeInstance("ReplicatedStorage", nil)
	return makeInstance("shared", replicatedStorage), makeInstance("server", replicatedStorage)
end

local guidCounter = 0
game = {
	GetService = function(_self, name)
		check(name == "HttpService", "unexpected service " .. name)
		return {
			GenerateGUID = function()
				guidCounter += 1
				return "guid-" .. guidCounter
			end,
		}
	end,
	FindService = function(_self, name)
		if name == "ReplicatedStorage" then
			return replicatedStorage
		end
		return nil
	end,
}

Instance = {
	new = function(className)
		check(className == "ModuleScript", "unexpected class " .. className)
		return makeInstance("", nil)
	end,
}

-- Lute freezes the real _G; the inlined module and the stub reader share this.
local _G = {}

local RuntimeStubHooks = __MODULE__

-- Evaluates a stub source of the form `return _G["key"]<.field | [n]>...`.
local function requireStub(stub: any): any
	local key, rest = string.match(stub.Source, '^return _G%["([^"]+)"%](.*)$')
	check(key ~= nil, "unrecognised stub source: " .. stub.Source)
	local value = _G[key]
	for kind, token in string.gmatch(rest, "([%.%[])([%w_]+)") do
		value = value[if kind == "[" then tonumber(token) else token]
	end

	return value
end

local function readConfigFileAndSetRootDir(stub: any): any
	local config = requireStub(stub)
	-- Mirrors jest-config readConfigFileAndSetRootDir: rootDir becomes the stub's parent unless it is an Instance.
	if type(config.rootDir) ~= "table" or not config.rootDir.isFakeInstance then
		config.rootDir = stub.Parent
	end

	return config
end

do
	local shared, server = makeTree()
	local hooks, cleanupAll = RuntimeStubHooks.create({
		{ "ReplicatedStorage/shared", "ReplicatedStorage/server" },
	})
	local cfg = { testMatch = { "**/*.spec" } }
	hooks.beforeConfig(cfg, 1)

	local sharedConfig = readConfigFileAndSetRootDir(shared:FindFirstChild("jest.config"))
	local serverConfig = readConfigFileAndSetRootDir(server:FindFirstChild("jest.config"))
	check(sharedConfig.rootDir == shared, "shared stub rootDir is not its mount")
	check(serverConfig.rootDir == server, "server stub rootDir is not its mount")
	check(serverConfig.testMatch == cfg.testMatch, "stub config lost session fields")

	hooks.afterConfig(cfg, 1)
	check(shared:FindFirstChild("jest.config") == nil, "shared stub survived cleanup")
	check(server:FindFirstChild("jest.config") == nil, "server stub survived cleanup")
	cleanupAll()
end

do
	local shared, server = makeTree()
	local userRoot = makeInstance("userRoot", nil)
	local hooks, cleanupAll = RuntimeStubHooks.create({
		{ "ReplicatedStorage/shared", "ReplicatedStorage/server" },
	})
	local cfg = { rootDir = userRoot }
	hooks.beforeConfig(cfg, 1)

	local sharedConfig = readConfigFileAndSetRootDir(shared:FindFirstChild("jest.config"))
	local serverConfig = readConfigFileAndSetRootDir(server:FindFirstChild("jest.config"))
	check(sharedConfig.rootDir == userRoot, "user rootDir overwritten on shared")
	check(serverConfig.rootDir == userRoot, "user rootDir overwritten on server")
	cleanupAll()
	check(shared:FindFirstChild("jest.config") == nil, "cleanupAll left a stub")
end

print("ALL OK")
