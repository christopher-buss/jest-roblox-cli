--!strict
local HttpService = game:GetService("HttpService")

local EmbeddedRunner = require("./embedded-runner")
local Envelope = require("../envelope")

type Payload = EmbeddedRunner.Payload
type ResultEntry = EmbeddedRunner.ResultEntry
type RunOutcome = EmbeddedRunner.RunOutcome

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local results: { ResultEntry }
local outcome: RunOutcome
if payload.queueId ~= nil and payload.queueId ~= "" then
	results, outcome = EmbeddedRunner.runWorkStealing(script, payload)
else
	results, outcome = EmbeddedRunner.runEmbedded(script, payload)
end

return HttpService:JSONEncode(Envelope.task(results, outcome)), "[]"
