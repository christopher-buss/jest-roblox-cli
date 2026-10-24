--!strict
local function describe(_name: string, body: () -> ()) body() end
local function it(_name: string, body: () -> ()) body() end

type Point = { x: number, y: number }

describe("Point", function()
	it("rejects a string field", function()
		-- @expect-error
		local _p: Point = {
			x = 1,
			y = "two",
		}
	end)
end)
