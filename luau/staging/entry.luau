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
-- True when this task stopped with work still in the queue because its return
-- envelope was full. The CLI answers it by launching another task.
local deferred = false
if payload.queueId ~= nil and payload.queueId ~= "" then
	results, deferred = EmbeddedRunner.runWorkStealing(script, payload)
else
	results, deferred = EmbeddedRunner.runEmbedded(script, payload)
end

local gameOutputs = {}
for _ = 1, #results do
	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({ deferred = deferred, entries = results }),
	table.concat(gameOutputs, "")
