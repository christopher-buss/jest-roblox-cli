--!strict
local t = require("@jest/typecheck")
local function localFn(c: { name: string }): { name: string } return c end
local exprFn = function(c: { name: string }): { name: string } return c end
local mod = require("./config")

t.describe('function values', function()
	t.it('localFn equals ({ name: string }) -> { name: string } (local function)', function()
		t.expectTypeOf(localFn):toEqualType<<({ name: string }) -> { name: string }>>()
	end)

	t.it('exprFn equals ({ name: string }, ...any) -> { name: string } (function expression has ...any tail)', function()
		t.expectTypeOf(exprFn):toEqualType<<({ name: string }, ...any) -> { name: string }>>()
	end)

	t.it('mod.defineConfig equals (mod.Config) -> mod.Config (required module fn)', function()
		t.expectTypeOf(mod.defineConfig):toEqualType<<(mod.Config) -> mod.Config>>()
	end)
end)
