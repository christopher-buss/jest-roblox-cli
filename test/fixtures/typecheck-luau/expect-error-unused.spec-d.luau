--!strict
local function it(_name: string, body: () -> ()) body() end

type Point = { x: number, y: number }

it("expects an error that never comes", function()
	-- @expect-error
	local _p: Point = { x = 1, y = 2 }
end)
