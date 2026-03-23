--!strict
local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if RunService:IsRunning() then
	return
end

local WEBSOCKET_URL = "ws://localhost:3001"
local RECONNECT_DELAY = 0.1

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

local autoReconnect = true
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

local function connect(): ()
	clearConnections()

	print("[jest-roblox] Connecting to " .. WEBSOCKET_URL .. "...")

	local success, socket = pcall(function(): WebStreamClient
		return HttpService:CreateWebStreamClient(
			Enum.WebStreamClientType.WebSocket,
			{ Url = WEBSOCKET_URL }
		)
	end)

	if not success then
		warn("[jest-roblox] Failed to connect: " .. tostring(socket))
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

			if message.action == "run_tests" then
				print("[jest-roblox] Running tests via StudioTestService...")

				local runOk, result = pcall(function(): any
					return StudioTestService:ExecuteRunModeAsync({
						test = true,
						config = message.config,
					})
				end)

				if not runOk then
					warn("[jest-roblox] ExecuteRunModeAsync failed: " .. tostring(result))
					ws:Send(HttpService:JSONEncode({
						type = "results",
						request_id = message.request_id,
						jestOutput = HttpService:JSONEncode({
							success = false,
							err = tostring(result),
						}),
						gameOutput = "[]",
					}))
					return
				end

				ws:Send(HttpService:JSONEncode({
					type = "results",
					request_id = message.request_id,
					jestOutput = result.jestOutput or HttpService:JSONEncode({
						success = false,
						err = "No jestOutput in run-mode result",
					}),
					gameOutput = result.gameOutput or "[]",
				}))

				print("[jest-roblox] Results sent")
			end
		end)
	)

	local opened = ws.Opened:Once(function(): ()
		print("[jest-roblox] Connected to CLI")
	end)
	table.insert(connections, opened)

	local err = ws.Error:Once(function(_statusCode: number, errorMessage: string): ()
		warn("[jest-roblox] Connection error: " .. errorMessage)
	end)
	table.insert(connections, err)

	local closed = ws.Closed:Once(function(): ()
		ws = nil
		if autoReconnect then
			print("[jest-roblox] Disconnected, reconnecting in " .. RECONNECT_DELAY .. "s...")
			local thread = task.delay(RECONNECT_DELAY, function(): ()
				connect()
			end)
			table.insert(connections :: any, {
				Disconnect = function(): ()
					if coroutine.running() then
						local wasCancelled = pcall(function()
							task.cancel(thread)
						end)

						if not wasCancelled then
							task.defer(function()
								task.cancel(thread)
							end)
						end
					end
				end,
			})
		end
	end)
	table.insert(connections, closed)
end

startButton.Click:Connect(function(): ()
	startButton.Enabled = false
	stopButton.Enabled = true
	autoReconnect = true
	connect()
end)

stopButton.Click:Connect(function(): ()
	stopButton.Enabled = false
	startButton.Enabled = true
	autoReconnect = false
	disconnect()
end)

plugin.Unloading:Connect(function(): ()
	autoReconnect = false
	disconnect()
end)

task.defer(connect)
