--!strict
local t = require("@jest/typecheck")
type GamePass = { name: string, price: number? }
local s: string = "x"
local m: number? = nil

t.describe('toExtend', function()
	t.it('GamePass extends a narrower table (width)', function()
		t.expectType<<GamePass>>():toExtend<<{ name: string }>>()
	end)

	t.it('a table missing name does not extend GamePass', function()
		-- @expect-error
		t.expectType<<{ price: number }>>():toExtend<<GamePass>>()
	end)

	t.it('a singleton extends its base', function()
		t.expectType<<"a">>():toExtend<<string>>()
	end)

	t.it('a too-wide union does not extend a member', function()
		-- @expect-error
		t.expectType<<string | number>>():toExtend<<string>>()
	end)

	t.it('never extends string', function()
		t.expectType<<never>>():toExtend<<string>>()
	end)

	t.it('string extends any', function()
		t.expectType<<string>>():toExtend<<any>>()
	end)

	t.it('any extends string', function()
		t.expectType<<any>>():toExtend<<string>>()
	end)

	t.it('s extends string?', function()
		t.expectTypeOf(s):toExtend<<string?>>()
	end)

	t.it('m does not extend number', function()
		-- @expect-error
		t.expectTypeOf(m):toExtend<<number>>()
	end)

	t.it('a table literal extends its shape', function()
		t.expectTypeOf({ name = "a" }):toExtend<<{ name: string }>>()
	end)

	t.it('a string literal extends string', function()
		t.expectTypeOf("a"):toExtend<<string>>()
	end)

	t.it('a number literal does not extend string', function()
		-- @expect-error
		t.expectTypeOf(1):toExtend<<string>>()
	end)
end)
