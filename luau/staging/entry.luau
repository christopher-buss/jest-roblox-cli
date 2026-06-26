--!strict
-- OCALE task script for workspace runs. Decodes the injected payload and
-- dispatches to the shared embedded runner: a `queueId` selects the MemoryStore
-- work-stealing variant (parallel OCALE tasks), otherwise the single-task
-- embedded walk. The Studio plugin's Run-mode runner drives `runEmbedded` from
-- the same module (single-process only).
local HttpService = game:GetService("HttpService")

local EmbeddedRunner = require("./embedded-runner")

type Payload = EmbeddedRunner.Payload
type ResultEntry = EmbeddedRunner.ResultEntry

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local results: { ResultEntry }
if payload.queueId ~= nil and payload.queueId ~= "" then
	results = EmbeddedRunner.runWorkStealing(script, payload)
else
	results = EmbeddedRunner.runEmbedded(script, payload)
end

local gameOutputs = {}
for _ = 1, #results do
	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({ entries = results }), table.concat(gameOutputs, "")
