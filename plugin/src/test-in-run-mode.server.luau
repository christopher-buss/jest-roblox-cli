--!strict
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsRunning() then
	return
end

local testArgs = StudioTestService:GetTestArgs()
if testArgs == nil then
	for _ = 1, 50 do
		task.wait(0.1)
		testArgs = StudioTestService:GetTestArgs()
		if testArgs ~= nil then
			break
		end
	end
end

if testArgs == nil or testArgs.configs == nil then
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
local entries = Runner.runProjects(script, testArgs.configs)

StudioTestService:EndTest({
	jestOutput = HttpService:JSONEncode({ entries = entries }),
	gameOutput = "[]",
})
