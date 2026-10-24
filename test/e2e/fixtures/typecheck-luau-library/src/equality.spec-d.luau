--!strict
local t = require("@jest/typecheck")
type GamePass = { name: string, price: number? }
type Box<T> = { value: T }
type Node = { next: Node? }
type Node2 = { next: Node2? }
type Obj = typeof(setmetatable({ x = 1 }, { __index = { get = function(self: any): number return 1 end } }))

t.describe('equality', function()
	t.it('any equals any', function()
		t.expectType<<any>>():toEqualType<<any>>()
	end)

	t.it('any does not equal string (any vs string)', function()
		-- @expect-error
		t.expectType<<any>>():toEqualType<<string>>()
	end)

	t.it('string does not equal any (string vs any)', function()
		-- @expect-error
		t.expectType<<string>>():toEqualType<<any>>()
	end)

	t.it('unknown does not equal any (unknown vs any)', function()
		-- @expect-error
		t.expectType<<unknown>>():toEqualType<<any>>()
	end)

	t.it('never equals never', function()
		t.expectType<<never>>():toEqualType<<never>>()
	end)

	t.it('unknown equals unknown', function()
		t.expectType<<unknown>>():toEqualType<<unknown>>()
	end)

	t.it('nil equals nil', function()
		t.expectType<<nil>>():toEqualType<<nil>>()
	end)

	t.it('"a" equals "a"', function()
		t.expectType<<"a">>():toEqualType<<"a">>()
	end)

	t.it('"a" does not equal "b"', function()
		-- @expect-error
		t.expectType<<"a">>():toEqualType<<"b">>()
	end)

	t.it('"a" does not equal string', function()
		-- @expect-error
		t.expectType<<"a">>():toEqualType<<string>>()
	end)

	t.it('true does not equal boolean', function()
		-- @expect-error
		t.expectType<<true>>():toEqualType<<boolean>>()
	end)

	t.it('string | number equals number | string (union order)', function()
		t.expectType<<string | number>>():toEqualType<<number | string>>()
	end)

	t.it('number? equals nil | number (optional sugar)', function()
		t.expectType<<number?>>():toEqualType<<nil | number>>()
	end)

	t.it('(string | number)? equals string | number | nil', function()
		t.expectType<<(string | number)?>>():toEqualType<<string | number | nil>>()
	end)

	t.it('string | number does not equal string', function()
		-- @expect-error
		t.expectType<<string | number>>():toEqualType<<string>>()
	end)

	t.it('boolean equals true | false (boolean as singletons)', function()
		t.expectType<<boolean>>():toEqualType<<true | false>>()
	end)

	t.it('"a" | "b" equals "b" | "a"', function()
		t.expectType<<"a" | "b">>():toEqualType<<"b" | "a">>()
	end)

	t.it('{ a: number } & { b: string } equals { b: string } & { a: number } (intersection order)', function()
		t.expectType<<{ a: number } & { b: string }>>():toEqualType<<{ b: string } & { a: number }>>()
	end)

	t.it('GamePass equals { price: number?, name: string } (prop order)', function()
		t.expectType<<GamePass>>():toEqualType<<{ price: number?, name: string }>>()
	end)

	t.it('GamePass does not equal { name: string } (missing prop)', function()
		-- @expect-error
		t.expectType<<GamePass>>():toEqualType<<{ name: string }>>()
	end)

	t.it('GamePass does not equal { name: string, price: number?, extra: number } (extra prop)', function()
		-- @expect-error
		t.expectType<<GamePass>>():toEqualType<<{ name: string, price: number?, extra: number }>>()
	end)

	t.it('{ a: { b: { c: number } } } equals { a: { b: { c: number } } } (nested)', function()
		t.expectType<<{ a: { b: { c: number } } }>>():toEqualType<<{ a: { b: { c: number } } }>>()
	end)

	t.it('{ a: { b: { c: number } } } does not equal { a: { b: { c: string } } } (nested diff)', function()
		-- @expect-error
		t.expectType<<{ a: { b: { c: number } } }>>():toEqualType<<{ a: { b: { c: string } } }>>()
	end)

	t.it('{ read a: number } does not equal { a: number } (read-only vs rw)', function()
		-- @expect-error
		t.expectType<<{ read a: number }>>():toEqualType<<{ a: number }>>()
	end)

	t.it('{ read a: number } equals { read a: number }', function()
		t.expectType<<{ read a: number }>>():toEqualType<<{ read a: number }>>()
	end)

	t.it('{ [string]: number } equals { [string]: number } (indexer)', function()
		t.expectType<<{ [string]: number }>>():toEqualType<<{ [string]: number }>>()
	end)

	t.it('{ [string]: number } does not equal { [string]: string } (indexer value)', function()
		-- @expect-error
		t.expectType<<{ [string]: number }>>():toEqualType<<{ [string]: string }>>()
	end)

	t.it('{ number } equals { [number]: number } (array sugar)', function()
		t.expectType<<{ number }>>():toEqualType<<{ [number]: number }>>()
	end)

	t.it('{ number } does not equal { string }', function()
		-- @expect-error
		t.expectType<<{ number }>>():toEqualType<<{ string }>>()
	end)

	t.it('{} equals {} (empty)', function()
		t.expectType<<{}>>():toEqualType<<{}>>()
	end)

	t.it('Box<number> equals { value: number } (generic alias expands)', function()
		t.expectType<<Box<number>>>():toEqualType<<{ value: number }>>()
	end)

	t.it('Box<number> does not equal Box<string>', function()
		-- @expect-error
		t.expectType<<Box<number>>>():toEqualType<<Box<string>>>()
	end)

	t.it('Node equals Node', function()
		t.expectType<<Node>>():toEqualType<<Node>>()
	end)

	t.it('Node equals Node2 (structurally same recursive)', function()
		t.expectType<<Node>>():toEqualType<<Node2>>()
	end)

	t.it('(number) -> string equals (number) -> string', function()
		t.expectType<<(number) -> string>>():toEqualType<<(number) -> string>>()
	end)

	t.it('(x: number) -> string equals (y: number) -> string (param names ignored)', function()
		t.expectType<<(x: number) -> string>>():toEqualType<<(y: number) -> string>>()
	end)

	t.it('(number) -> string does not equal (string) -> string (param)', function()
		-- @expect-error
		t.expectType<<(number) -> string>>():toEqualType<<(string) -> string>>()
	end)

	t.it('(number) -> string does not equal (number) -> number (return)', function()
		-- @expect-error
		t.expectType<<(number) -> string>>():toEqualType<<(number) -> number>>()
	end)

	t.it('(number) -> () does not equal (number, string) -> () (arity)', function()
		-- @expect-error
		t.expectType<<(number) -> ()>>():toEqualType<<(number, string) -> ()>>()
	end)

	t.it('(...number) -> () equals (...number) -> () (variadic)', function()
		t.expectType<<(...number) -> ()>>():toEqualType<<(...number) -> ()>>()
	end)

	t.it('(...number) -> () does not equal (...string) -> () (variadic)', function()
		-- @expect-error
		t.expectType<<(...number) -> ()>>():toEqualType<<(...string) -> ()>>()
	end)

	t.it('() -> (number, string) equals () -> (number, string) (multi-return)', function()
		t.expectType<<() -> (number, string)>>():toEqualType<<() -> (number, string)>>()
	end)

	t.it('() -> (number, string) does not equal () -> (string, number) (multi-return order)', function()
		-- @expect-error
		t.expectType<<() -> (number, string)>>():toEqualType<<() -> (string, number)>>()
	end)

	t.it('<A>(A) -> A equals <B>(B) -> B (generic fn renamed)', function()
		t.expectType<<<A>(A) -> A>>():toEqualType<<<B>(B) -> B>>()
	end)

	t.it('<A>(A) -> A does not equal (number) -> number (generic vs concrete)', function()
		-- @expect-error
		t.expectType<<<A>(A) -> A>>():toEqualType<<(number) -> number>>()
	end)

	t.it('Obj equals Obj', function()
		t.expectType<<Obj>>():toEqualType<<Obj>>()
	end)

	t.it('Obj does not equal { x: number } (metatable vs plain)', function()
		-- @expect-error
		t.expectType<<Obj>>():toEqualType<<{ x: number }>>()
	end)
end)
