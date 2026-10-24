--!strict
local function it(_name: string, body: () -> ()) body() end

local _bad: number = "nope"

it("passes", function()
	local _n: number = 1
end)
