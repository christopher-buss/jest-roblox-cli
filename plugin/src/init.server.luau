--!strict
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsEdit() then
	return
end

local Shared = script:WaitForChild("shared")
local Envelope = require(Shared:WaitForChild("envelope") :: any)
local Protocol = require(Shared:WaitForChild("protocol") :: any)
local PROTOCOL_VERSION = Protocol.studio.protocolVersion
local FRAME = Protocol.studio.frame

local RECONNECT_DELAY = 0.1
local MAX_RECONNECT_DELAY = 5

local socketUrl = require(script:WaitForChild("socket-url") :: any)

-- Written by `scripts/stamp-plugin-version.ts` at build time, and absent from a
-- tree served straight out of source control. Diagnostic only: the CLI selects
-- on PROTOCOL_VERSION and reports this so a user running several installed
-- copies is told which file to remove.
--
-- `script` is the plugin root here (rojo maps `src/init.server.luau` onto the
-- tree root), so `version` is a child of it rather than a sibling, unlike in
-- the run-mode runner beside this file.
local versionOk, PluginVersion =
	pcall(require, script:FindFirstChild(Protocol.studio.pluginVersionModule) :: any)
if not versionOk or typeof(PluginVersion) ~= "string" then
	PluginVersion = "unknown"
end

local ReconnectLoop = require(script:WaitForChild("reconnect-loop") :: any)

local IsDebug = ReplicatedStorage:GetAttribute("JEST_ROBLOX_DEBUG") == true
ReplicatedStorage:GetAttributeChangedSignal("JEST_ROBLOX_DEBUG"):Connect(function(): ()
	IsDebug = ReplicatedStorage:GetAttribute("JEST_ROBLOX_DEBUG") == true
end)

local toolbar = plugin:CreateToolbar("Jest-Roblox")
local startButton =
	toolbar:CreateButton("Jest Roblox", "Connect to jest-roblox CLI", "rbxassetid://4458901886")
local stopButton =
	toolbar:CreateButton("Stop", "Disconnect from jest-roblox CLI", "rbxassetid://4458901886")
startButton.Enabled = false

local ws: WebStreamClient? = nil
local connections: { RBXScriptConnection } = {}

local _print = print
local _warn = warn

local function print(...: any): ()
	if IsDebug then
		_print("[jest-roblox]", ...)
	end
end

local function warn(...: any): ()
	if IsDebug then
		_warn("[jest-roblox]", ...)
	end
end

local function clearConnections(): ()
	for _, connection in connections do
		connection:Disconnect()
	end

	table.clear(connections)
end

local function disconnect(): ()
	clearConnections()

	if ws then
		pcall(function(): ()
			assert(ws, "Luau")
			ws:Close()
		end)
		ws = nil
	end
end

local function connect(attempt: any): ()
	disconnect()

	local url = socketUrl(Protocol.studio, function(name: string): any
		return ReplicatedStorage:GetAttribute(name)
	end)
	print("[jest-roblox] Connecting to " .. url .. "...")

	local success, socket = pcall(function(): WebStreamClient
		return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = url })
	end)

	if not success then
		warn("[jest-roblox] Failed to connect: " .. tostring(socket))
		attempt.failed()
		return
	end

	ws = socket
	assert(ws, "Luau")

	table.insert(
		connections,
		ws.MessageReceived:Connect(function(rawMessage: string): ()
			assert(ws, "Luau")

			local ok, message = pcall(function(): any
				return HttpService:JSONDecode(rawMessage)
			end)
			if not ok then
				warn("[jest-roblox] Failed to decode message:", rawMessage)
				return
			end

			if message.action == Protocol.studio.runTestsAction then
				-- Version handshake: reject a missing or mismatched
				-- `protocolVersion` synchronously so the user sees an
				-- upgrade message rather than stale-semantics behaviour.
				local clientVersion = if typeof(message.protocolVersion) == "number"
					then message.protocolVersion
					else nil
				if clientVersion ~= PROTOCOL_VERSION then
					warn(
						"[jest-roblox] Protocol version mismatch: CLI v"
							.. tostring(clientVersion)
							.. ", plugin v"
							.. tostring(PROTOCOL_VERSION)
					)
					ws:Send(HttpService:JSONEncode({
						type = FRAME.versionMismatch,
						actualVersion = PROTOCOL_VERSION,
						expectedVersion = clientVersion or 0,
						requestId = message.requestId,
					}))
					return
				end

				print("[jest-roblox] Running tests via StudioTestService...")

				local payload = table.clone(message)
				payload.action = nil
				payload.requestId = nil
				payload.test = true
				payload.protocolVersion = PROTOCOL_VERSION

				local runOk, result = pcall(function(): any
					return StudioTestService:ExecuteRunModeAsync(payload)
				end)

				if not runOk then
					warn("[jest-roblox] ExecuteRunModeAsync failed: " .. tostring(result))
					ws:Send(HttpService:JSONEncode({
						type = FRAME.results,
						protocolVersion = PROTOCOL_VERSION,
						requestId = message.requestId,
						jestOutput = HttpService:JSONEncode(Envelope.failure(tostring(result))),
						gameOutput = "[]",
					}))
					return
				end

				ws:Send(HttpService:JSONEncode({
					type = FRAME.results,
					-- Echo the protocol version. A stale plugin that ignored
					-- the request-side version would also omit the echo, so
					-- the CLI's schema validation rejects it as malformed
					-- rather than treating it as a valid v1 success.
					protocolVersion = PROTOCOL_VERSION,
					requestId = message.requestId,
					jestOutput = result.jestOutput or HttpService:JSONEncode(
						Envelope.failure("No jestOutput in run-mode result")
					),
					gameOutput = result.gameOutput or "[]",
				}))

				print("[jest-roblox] Results sent")
			end
		end)
	)

	local opened = ws.Opened:Once(function(): ()
		print("[jest-roblox] Connected to CLI")
		attempt.opened()

		-- Announce unprompted, as early as a send is legal. Studio runs every
		-- installed copy of this plugin and each one dials the same port, so
		-- the CLI has to choose between the sockets before it dispatches:
		-- without this it would ask all of them and settle on whichever
		-- answered first, which is always the copy that refuses outright.
		assert(ws, "Luau")
		ws:Send(HttpService:JSONEncode({
			type = FRAME.hello,
			protocolVersion = PROTOCOL_VERSION,
			pluginVersion = PluginVersion,
			pluginName = plugin.Name,
		}))
	end)
	table.insert(connections, opened)

	local err = ws.Error:Once(function(_statusCode: number, errorMessage: string): ()
		warn("[jest-roblox] Connection error: " .. errorMessage)
		disconnect()
		attempt.failed()
	end)
	table.insert(connections, err)

	local closed = ws.Closed:Once(function(): ()
		print("[jest-roblox] Disconnected")
		disconnect()
		attempt.failed()
	end)
	table.insert(connections, closed)
end

local reconnectLoop = ReconnectLoop.new({
	cancel = task.cancel,
	connect = connect,
	delay = task.delay,
	initialDelay = RECONNECT_DELAY,
	maxDelay = MAX_RECONNECT_DELAY,
})

startButton.Click:Connect(function(): ()
	startButton.Enabled = false
	stopButton.Enabled = true
	reconnectLoop:start()
end)

stopButton.Click:Connect(function(): ()
	stopButton.Enabled = false
	startButton.Enabled = true
	reconnectLoop:stop()
	disconnect()
end)

plugin.Unloading:Connect(function(): ()
	reconnectLoop:stop()
	disconnect()
end)

task.defer(function(): ()
	reconnectLoop:start()
end)
