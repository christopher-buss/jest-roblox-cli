--!strict
local t = require("@jest/typecheck")
type Node = { next: Node? }
local defineConfig = function(c: { name: string }): { name: string } return c end

t.describe('equality edge cases', function()
	t.it('boolean does not equal true (boolean vs true)', function()
		-- @expect-error
		t.expectType<<boolean>>():toEqualType<<true>>()
	end)

	t.it('boolean? equals true | false | nil', function()
		t.expectType<<boolean?>>():toEqualType<<true | false | nil>>()
	end)

	t.it('{ a: number } does not equal { a: number, [string]: any } (extra indexer)', function()
		-- @expect-error
		t.expectType<<{ a: number }>>():toEqualType<<{ a: number, [string]: any }>>()
	end)

	t.it('{ [string]: number } does not equal { [number]: number } (indexer key)', function()
		-- @expect-error
		t.expectType<<{ [string]: number }>>():toEqualType<<{ [number]: number }>>()
	end)

	t.it('<A, B>(A, B) -> A equals <X, Y>(X, Y) -> X (two generics renamed)', function()
		t.expectType<<<A, B>(A, B) -> A>>():toEqualType<<<X, Y>(X, Y) -> X>>()
	end)

	t.it('<A, B>(A, B) -> A does not equal <X, Y>(X, Y) -> Y (generic position)', function()
		-- @expect-error
		t.expectType<<<A, B>(A, B) -> A>>():toEqualType<<<X, Y>(X, Y) -> Y>>()
	end)

	t.it('<A>(A) -> A does not equal <A, B>(A) -> A (generic count)', function()
		-- @expect-error
		t.expectType<<<A>(A) -> A>>():toEqualType<<<A, B>(A) -> A>>()
	end)

	t.it('<A...>(A...) -> A... equals <B...>(B...) -> B... (generic pack renamed)', function()
		t.expectType<<<A...>(A...) -> A...>>():toEqualType<<<B...>(B...) -> B...>>()
	end)

	t.it('<A...>(A...) -> A... does not equal <B...>(B...) -> () (generic pack return)', function()
		-- @expect-error
		t.expectType<<<A...>(A...) -> A...>>():toEqualType<<<B...>(B...) -> ()>>()
	end)

	t.it('Node does not equal { next: { next: number }? } (recursive vs finite)', function()
		-- @expect-error
		t.expectType<<Node>>():toEqualType<<{ next: { next: number }? }>>()
	end)

	t.it('() -> () does not equal {} (function vs table)', function()
		-- @expect-error
		t.expectType<<() -> ()>>():toEqualType<<{}>>()
	end)

	t.it('{ a: string | number } equals { a: number | string } (nested union order)', function()
		t.expectType<<{ a: string | number }>>():toEqualType<<{ a: number | string }>>()
	end)

	t.it('{ write a: number } does not equal { a: number } (write-only)', function()
		-- @expect-error
		t.expectType<<{ write a: number }>>():toEqualType<<{ a: number }>>()
	end)

	t.it('{ a: number }? does not equal { a: number } (optional table)', function()
		-- @expect-error
		t.expectType<<{ a: number }?>>():toEqualType<<{ a: number }>>()
	end)

	t.it('string | (number | boolean) equals (string | number) | boolean (nested unions flatten)', function()
		t.expectType<<string | (number | boolean)>>():toEqualType<<(string | number) | boolean>>()
	end)

	t.it('{ a: number } & { a: string } equals { a: string } & { a: number }', function()
		t.expectType<<{ a: number } & { a: string }>>():toEqualType<<{ a: string } & { a: number }>>()
	end)

	t.it('typeof(print) equals typeof(print) (builtin)', function()
		t.expectType<<typeof(print)>>():toEqualType<<typeof(print)>>()
	end)

	t.it('buffer equals buffer', function()
		t.expectType<<buffer>>():toEqualType<<buffer>>()
	end)

	t.it('thread does not equal buffer', function()
		-- @expect-error
		t.expectType<<thread>>():toEqualType<<buffer>>()
	end)

	t.it('vector equals vector', function()
		t.expectType<<vector>>():toEqualType<<vector>>()
	end)

	t.it('(number) -> ...string equals (number) -> ...string (variadic return)', function()
		t.expectType<<(number) -> ...string>>():toEqualType<<(number) -> ...string>>()
	end)

	t.it('(number) -> ...string does not equal (number) -> string (variadic vs single)', function()
		-- @expect-error
		t.expectType<<(number) -> ...string>>():toEqualType<<(number) -> string>>()
	end)

	t.it('{ f: (self: any) -> number } equals { f: (any) -> number }', function()
		t.expectType<<{ f: (self: any) -> number }>>():toEqualType<<{ f: (any) -> number }>>()
	end)

	t.it('defineConfig equals ({ name: string }) -> { name: string } (fn expression (...any tail ignored))', function()
		t.expectTypeOf(defineConfig):toEqualType<<({ name: string }) -> { name: string }>>()
	end)

	t.it('defineConfig does not equal ({ name: string }) -> { name: number }', function()
		-- @expect-error
		t.expectTypeOf(defineConfig):toEqualType<<({ name: string }) -> { name: number }>>()
	end)

	t.it('{ name = "a", price = 1 } equals { name: string, price: number } (literal widening)', function()
		t.expectTypeOf({ name = "a", price = 1 }):toEqualType<<{ name: string, price: number }>>()
	end)

	t.it('"a" equals string (string literal widens?)', function()
		t.expectTypeOf("a"):toEqualType<<string>>()
	end)

	t.it('1 :: number? equals number?', function()
		t.expectTypeOf(1 :: number?):toEqualType<<number?>>()
	end)

	t.it('(number, ...any) -> () equals (number) -> () (param ...any tail ignored)', function()
		t.expectType<<(number, ...any) -> ()>>():toEqualType<<(number) -> ()>>()
	end)

	t.it('() -> (number, ...any) does not equal () -> number (return ...any tail kept)', function()
		-- @expect-error
		t.expectType<<() -> (number, ...any)>>():toEqualType<<() -> number>>()
	end)

	t.it('(number, ...any) -> () does not equal (number, string) -> ()', function()
		-- @expect-error
		t.expectType<<(number, ...any) -> ()>>():toEqualType<<(number, string) -> ()>>()
	end)

	t.it('{ a: number } | string does not equal { a: number } | string | { b: number } (extra union member)', function()
		-- @expect-error
		t.expectType<<{ a: number } | string>>():toEqualType<<{ a: number } | string | { b: number }>>()
	end)

	t.it('{ a: number } & { c: string } does not equal { b: number } & { a: number } & { c: string } (extra intersection member)', function()
		-- @expect-error
		t.expectType<<{ a: number } & { c: string }>>():toEqualType<<{ b: number } & { a: number } & { c: string }>>()
	end)

	t.it('<A, B>(A, B) -> A | string does not equal a union adding <X, Y>(X, Y) -> Y (extra generic member)', function()
		-- @expect-error
		t.expectType<<(<A, B>(A, B) -> A) | string>>():toEqualType<<(<X, Y>(X, Y) -> Y) | (<X, Y>(X, Y) -> X) | string>>()
	end)
end)
