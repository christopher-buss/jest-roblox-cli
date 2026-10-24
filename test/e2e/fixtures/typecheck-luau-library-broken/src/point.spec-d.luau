--!strict
local t = require("@jest/typecheck")

type Point = { x: number, y: number }

t.describe("Point", function()
	t.it("has numeric fields", function()
		t.expectType<<Point>>():toEqualType<<{ x: number, y: string }>>()
	end)
end)
