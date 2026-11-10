--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Protocol = require("./protocol")
local RunnerError = require("./runner-error")

local module = {}

function module.findInstance(path: string): Instance
	local parts = string.split(path, "/")

	local success, current = pcall(function()
		return game:FindService(parts[1])
	end)
	if not success or current == nil then
		RunnerError.raise(
			Protocol.errorCodes.ServiceNotFound,
			`Failed to find service {parts[1]}: {current}`
		)
	end

	for i = 2, #parts do
		assert(current, `Failed to find '{parts[i - 1]}' in path {path}`)
		current = current:FindFirstChild(parts[i])
	end

	assert(current, `Failed to find instance at path {path}`)

	return current
end

function module.getJest(config: { jestPath: string? }): ModuleScript
	local jestPath = config.jestPath
	if jestPath then
		local found, instance = pcall(module.findInstance, jestPath)
		if not found and RunnerError.codeOf(instance) ~= nil then
			error(instance, 0)
		end
		if not found then
			RunnerError.raise(
				Protocol.errorCodes.JestPathUnresolved,
				`Failed to find Jest instance at path {jestPath}: {instance}`
			)
		end
		if not instance:IsA("ModuleScript") then
			RunnerError.raise(
				Protocol.errorCodes.JestPathUnresolved,
				`Instance at path {jestPath} is not a ModuleScript`
			)
		end
		return instance :: ModuleScript
	end

	local jestInstance = ReplicatedStorage:FindFirstChild("Jest", true)
	if jestInstance == nil then
		RunnerError.raise(
			Protocol.errorCodes.JestNotFound,
			"Failed to find Jest instance in ReplicatedStorage"
		)
	end
	if not (jestInstance :: Instance):IsA("ModuleScript") then
		RunnerError.raise(
			Protocol.errorCodes.JestNotFound,
			"Jest instance in ReplicatedStorage is not a ModuleScript"
		)
	end
	return jestInstance :: ModuleScript
end

function module.findRobloxShared(jestModule: ModuleScript): Instance?
	local parent = jestModule.Parent
	if parent then
		local found = parent:FindFirstChild("RobloxShared")
			or parent:FindFirstChild("jest-roblox-shared")
		if found then
			return found
		end

		if parent.Parent then
			found = parent.Parent:FindFirstChild("RobloxShared")
				or parent.Parent:FindFirstChild("jest-roblox-shared")
			if found then
				return found
			end
		end
	end

	return game:FindFirstChild("RobloxShared", true)
end

function module.findSiblingPackage(jestModule: ModuleScript, ...: string): Instance?
	local parent = jestModule.Parent
	if parent then
		for _, name in { ... } do
			local found = parent:FindFirstChild(name)
			if found then
				return found
			end
		end

		if parent.Parent then
			for _, name in { ... } do
				local found = parent.Parent:FindFirstChild(name)
				if found then
					return found
				end
			end
		end
	end

	for _, name in { ... } do
		local found = game:FindFirstChild(name, true)
		if found then
			return found
		end
	end

	return nil
end

function module.findCircusModule(circusPackage: Instance, name: string): Instance?
	local circus = circusPackage:FindFirstChild("circus")
	return if circus then circus:FindFirstChild(name) else nil
end

return module
