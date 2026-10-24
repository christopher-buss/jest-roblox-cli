--!strict
local function it(_name: string, body: () -> ()) body() end

local source = require("./source")

it("reads the source", function()
	local _n: number = source.value
end)
