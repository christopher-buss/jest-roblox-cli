--!strict
local t = require("@jest/typecheck")
local s: string = "x"
local m: number? = nil

t.describe('never matchers', function()
	t.it('string is not number', function()
		t.expectType<<string>>().never:toEqualType<<number>>()
	end)

	t.it('string is string', function()
		-- @expect-error
		t.expectType<<string>>().never:toEqualType<<string>>()
	end)

	t.it('reordered unions are equal', function()
		-- @expect-error
		t.expectType<<string | number>>().never:toEqualType<<number | string>>()
	end)

	t.it('s is not number', function()
		t.expectTypeOf(s).never:toEqualType<<number>>()
	end)

	t.it('string is not m (optional value)', function()
		t.expectType<<string>>().never:toEqualTypeOf(m)
	end)

	t.it('number? is m (optional value)', function()
		-- @expect-error
		t.expectType<<number?>>().never:toEqualTypeOf(m)
	end)

	t.it('number is not number?', function()
		t.expectType<<number>>().never:toEqualType<<number?>>()
	end)
end)
