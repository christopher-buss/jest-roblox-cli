--!strict
local t = require("@jest/typecheck")
local function id<A>(a: A): A return a end
local function pair<A, B>(a: A, b: B): (A, B) return a, b end
local anything: any = nil

t.describe('generic function values', function()
	t.it('id equals <B>(B) -> B (generic fn value keeps generics)', function()
		t.expectTypeOf(id):toEqualType<<<B>(B) -> B>>()
	end)

	t.it('id does not equal (number) -> number', function()
		-- @expect-error
		t.expectTypeOf(id):toEqualType<<(number) -> number>>()
	end)

	t.it('pair equals <X, Y>(X, Y) -> (X, Y)', function()
		t.expectTypeOf(pair):toEqualType<<<X, Y>(X, Y) -> (X, Y)>>()
	end)

	t.it('anything equals any', function()
		t.expectTypeOf(anything):toEqualType<<any>>()
	end)

	t.it('anything does not equal string', function()
		-- @expect-error
		t.expectTypeOf(anything):toEqualType<<string>>()
	end)
end)
