--!strict
local HttpService = game:GetService("HttpService")

local Runner = require("./runner")

local payload = HttpService:JSONDecode([=[__CONFIG_JSON__]=])
local entries = Runner.runProjects(script, payload.configs)

return HttpService:JSONEncode({ entries = entries }), "[]"
