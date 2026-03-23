--!strict
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsRunning() then
	return
end

local testArgs = StudioTestService:GetTestArgs()
if not testArgs or not testArgs.test then
	return
end

local loadStringEnabled = pcall(function()
	loadstring("return true")
end)

if not loadStringEnabled then
	StudioTestService:EndTest({
		jestOutput = HttpService:JSONEncode({
			success = false,
			err = "LoadString must be enabled in ServerScriptService to run tests",
		}),
		gameOutput = "[]",
	})
	return
end

local Runner = require(script.Parent.shared.runner)
local jestOutput, gameOutput = Runner.run(script, testArgs.config or {})

StudioTestService:EndTest({
	jestOutput = jestOutput,
	gameOutput = gameOutput,
})
