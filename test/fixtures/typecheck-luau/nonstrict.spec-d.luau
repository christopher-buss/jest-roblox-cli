--!nonstrict
local function it(_name: string, body: () -> ()) body() end

it("passes", function()
	local _n: number = "nope"
end)
