--!strict
local dataModelPath = require("../data-model-path")

local CoreScriptSyncService = {}

function CoreScriptSyncService:GetScriptFilePath(instance: Instance): string
	return dataModelPath(instance)
end

return CoreScriptSyncService
