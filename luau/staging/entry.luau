--!strict
-- OCALE task script for workspace runs. Decodes the injected payload and
-- dispatches to the shared embedded runner: a `queueId` selects the MemoryStore
-- work-stealing variant (parallel OCALE tasks), otherwise the plain embedded
-- walk over whatever entries this task carries. The Studio plugin's Run-mode
-- runner drives `runEmbedded` from the same module (single-process only).
local HttpService = game:GetService("HttpService")

local EmbeddedRunner = require("./embedded-runner")

type Payload = EmbeddedRunner.Payload
type ResultEntry = EmbeddedRunner.ResultEntry
type RunOutcome = EmbeddedRunner.RunOutcome

local payload: Payload = HttpService:JSONDecode([==[__CONFIG_JSON__]==]) :: Payload

local results: { ResultEntry }
-- Why this task stopped with work still outstanding: `deferred` (its return
-- envelope was full, so the CLI launches another task) or `bailed` (a package
-- failed under --bail, so the CLI reports the run short and launches none).
local outcome: RunOutcome
if payload.queueId ~= nil and payload.queueId ~= "" then
	results, outcome = EmbeddedRunner.runWorkStealing(script, payload)
else
	results, outcome = EmbeddedRunner.runEmbedded(script, payload)
end

local gameOutputs = {}
for _ = 1, #results do
	table.insert(gameOutputs, "[]")
end

return HttpService:JSONEncode({
	bailed = outcome.bailed,
	deferred = outcome.deferred,
	entries = results,
}),
	table.concat(gameOutputs, "")
