--!strict
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

if not RunService:IsRunning() then
	return
end

local function endWithError(err: string): ()
	local ok, endErr = pcall(function()
		StudioTestService:EndTest({
			jestOutput = HttpService:JSONEncode({ success = false, err = err }),
			gameOutput = "[]",
		})
	end)
	if not ok then
		warn("[jest-roblox] EndTest failed: " .. tostring(endErr))
	end
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

if testArgs == nil then
	return
end

if testArgs.config == nil or testArgs.config.configs == nil then
	local keysOk, keys = pcall(HttpService.JSONEncode, HttpService, testArgs)
	endWithError(
		"testArgs.config.configs is nil. Keys: " .. (if keysOk then keys else "<unencodable>")
	)
	return
end

local configs = testArgs.config.configs

local loadStringEnabled = pcall(function()
	loadstring("return true")
end)

if not loadStringEnabled then
	endWithError("LoadString must be enabled in ServerScriptService to run tests")
	return
end

local requireOk, Runner = pcall(require, script.Parent.shared.runner)
if not requireOk then
	endWithError("Failed to require shared.runner: " .. tostring(Runner))
	return
end

local runOk, entriesOrErr = pcall(Runner.runProjects, script, configs)
if not runOk then
	endWithError("Runner.runProjects threw: " .. tostring(entriesOrErr))
	return
end

StudioTestService:EndTest({
	jestOutput = HttpService:JSONEncode({ entries = entriesOrErr }),
	gameOutput = "[]",
})
