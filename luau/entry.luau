--!strict
local HttpService = game:GetService("HttpService")

local Envelope = require("./envelope")
local Runner = require("./runner")

local payload = HttpService:JSONDecode([=[__CONFIG_JSON__]=])

local entries = Runner.runProjects(script, payload.configs)

return HttpService:JSONEncode(Envelope.task(entries)), "[]"
