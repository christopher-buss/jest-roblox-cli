--!strict
local t = require("@jest/typecheck")
type GamePass = { name: string, price: number? }
local s: string = "x"
local m: number? = nil

t.describe('value matchers', function()
	t.it('string equals s (value form)', function()
		t.expectType<<string>>():toEqualTypeOf(s)
	end)

	t.it('number does not equal s', function()
		-- @expect-error
		t.expectType<<number>>():toEqualTypeOf(s)
	end)

	t.it('number? equals m (optional value)', function()
		t.expectType<<number?>>():toEqualTypeOf(m)
	end)

	t.it('number does not equal m (optional value)', function()
		-- @expect-error
		t.expectType<<number>>():toEqualTypeOf(m)
	end)

	t.it('m equals number?', function()
		t.expectTypeOf(m):toEqualType<<number?>>()
	end)

	t.it('m does not equal number', function()
		-- @expect-error
		t.expectTypeOf(m):toEqualType<<number>>()
	end)
end)
