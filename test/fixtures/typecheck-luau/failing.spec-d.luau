--!strict
local function describe(_name: string, body: () -> ()) body() end
local function it(_name: string, body: () -> ()) body() end

type Point = { x: number, y: number }

describe("Point", function()
	it("accepts numeric fields", function()
		local _p: Point = { x = 1, y = 2 }
	end)

	it("rejects a string field", function()
		local _p: Point = { x = "é", y = 2 }
	end)
end)
