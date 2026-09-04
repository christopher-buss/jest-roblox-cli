--!strict
local HttpService = game:GetService("HttpService")

local Runner = require("./runner")
local TestProgress = require("./test-progress")

local payload = HttpService:JSONDecode([=[__CONFIG_JSON__]=])

-- Built once per task, so the run heartbeats under one key the host reads back
-- if the task never returns. Absent unless the CLI asked for one.
local progress = payload.progress
local publishProgress = if progress
	then TestProgress.sortedMapPublisher(progress.mapId, progress.ttlSeconds)
	else nil

local entries = Runner.runProjects(script, payload.configs, nil, publishProgress)

return HttpService:JSONEncode({ entries = entries }), "[]"
