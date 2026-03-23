--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local module = {}

function module.findInstance(path: string): Instance
	local parts = string.split(path, "/")

	local success, current = pcall(function()
		return game:FindService(parts[1])
	end)
	assert(success, `Failed to find service {parts[1]}: {current}`)

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
		local instance = module.findInstance(jestPath)
		assert(instance, `Failed to find Jest instance at path {jestPath}`)
		assert(instance:IsA("ModuleScript"), `Instance at path {jestPath} is not a ModuleScript`)
		return instance :: ModuleScript
	end

	local jestInstance = ReplicatedStorage:FindFirstChild("Jest", true)
	assert(jestInstance, "Failed to find Jest instance in ReplicatedStorage")
	assert(jestInstance:IsA("ModuleScript"), "Jest instance in ReplicatedStorage is not a ModuleScript")
	return jestInstance
end

function module.findRobloxShared(jestModule: ModuleScript): Instance?
	local parent = jestModule.Parent
	if parent then
		local found = parent:FindFirstChild("RobloxShared") or parent:FindFirstChild("jest-roblox-shared")
		if found then
			return found
		end

		if parent.Parent then
			found = parent.Parent:FindFirstChild("RobloxShared") or parent.Parent:FindFirstChild("jest-roblox-shared")
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

return module
