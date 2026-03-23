--!strict
local HttpService = game:GetService("HttpService")

local Runner = require("./runner")

local config = HttpService:JSONDecode([=[__CONFIG_JSON__]=])

return Runner.run(script, config)
