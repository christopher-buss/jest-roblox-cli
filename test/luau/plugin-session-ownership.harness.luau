--!nocheck
local request = __REQUEST__
local sideChannelPayload = __SIDE_CHANNEL_PAYLOAD__
local results = {}
local relayedResults = {}
local encoded = {}
local elapsed = 0
local attributes = {}
local receiveRelay = nil

local HttpService = {}
function HttpService:JSONEncode(value)
	local token = "json#" .. tostring(#encoded + 1)
	table.insert(encoded, value)
	encoded[token] = value
	return token
end

function HttpService:JSONDecode(token)
	return encoded[token]
end

function HttpService:CreateWebStreamClient()
	return {
		Opened = { Once = function(_self, callback) callback() end },
		MessageReceived = { Connect = function(_self, callback) receiveRelay = callback end },
		Send = function(_self, token)
			local frame = HttpService:JSONDecode(token)
			if frame.type == "results" then
				table.insert(relayedResults, frame)
			end
		end,
	}
end

if sideChannelPayload ~= nil then
	attributes.JestRobloxRunSideChannel = HttpService:JSONEncode({
		url = "ws://127.0.0.1:12345",
		requestId = "request-123",
		payload = sideChannelPayload,
	})
end

local ReplicatedStorage = {}
function ReplicatedStorage:GetAttribute(name)
	return attributes[name]
end

function ReplicatedStorage:SetAttribute(name, value)
	attributes[name] = value
end

local StudioTestService = {}
function StudioTestService:GetTestArgs()
	return request
end

function StudioTestService:EndTest(result)
	table.insert(results, result)
end

local services = {
	HttpService = HttpService,
	ReplicatedStorage = ReplicatedStorage,
	RunService = { IsRunning = function() return true end },
	StudioTestService = StudioTestService,
	MemoryStoreService = {},
	LogService = {},
	Lighting = {},
	ServerStorage = {},
	StarterPlayer = {},
}
local game = {}
function game:GetService(name)
	assert(services[name], "Unexpected service: " .. name)
	return services[name]
end

local os = { clock = function() return elapsed end }
local task = {
	wait = function(seconds)
		elapsed += seconds
		if receiveRelay ~= nil then
			receiveRelay(HttpService:JSONEncode({ type = "nilRelay", requestId = "request-123" }))
			receiveRelay = nil
		end
		return seconds
	end,
}
local loadstring = function(source)
	assert(source == "return true", "Unexpected LoadString request")
	return function() return true end
end
local Enum = {
	WebStreamClientType = { WebSocket = "WebSocket" },
	MessageType = { MessageOutput = { Value = 0 }, MessageWarning = { Value = 2 } },
}
local script = {
	Parent = {
		FindFirstChild = function() return nil end,
		shared = { ["vm-parallel"] = "vm-parallel", staging = { ["embedded-runner"] = "staging/embedded-runner" } },
	},
}
local factories = {}
local loaded = {}
local loadModule
loadModule = function(module)
	assert(factories[module], "ModuleScript is absent: " .. tostring(module))
	if loaded[module] == nil then
		loaded[module] = factories[module]()
	end
	return loaded[module]
end
local require = loadModule
local warn = function(message) error(message, 0) end

__MODULES__

local function runPlugin()
__PLUGIN__
end

runPlugin()
__ASSERTION__
print("ALL OK")
