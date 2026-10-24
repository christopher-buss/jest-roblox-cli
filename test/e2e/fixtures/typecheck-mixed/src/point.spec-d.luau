--!strict
local function describe(_name: string, body: () -> ()) body() end
local function it(_name: string, body: () -> ()) body() end

type Point = { x: number, y: number }

describe("Point", function()
	it("accepts numeric fields", function()
		local _p: Point = { x = 1, y = 2 }
	end)

	it("accepts a number", function()
		local _n: number = 1
	end)
end)
