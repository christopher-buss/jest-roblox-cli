--!strict
local function getInstancePath(instance: Instance): string
	local parts = {} :: { string }
	local current: Instance? = instance
	while current and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end

	return table.concat(parts, "/")
end

local CoreScriptSyncService = {}

function CoreScriptSyncService:GetScriptFilePath(instance: Instance): string
	return getInstancePath(instance)
end

return CoreScriptSyncService
