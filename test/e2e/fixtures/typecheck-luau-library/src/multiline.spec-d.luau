--!strict
local t = require("@jest/typecheck")
type G = { name: string, price: number? }
type Expected = {
	name: string,
	price: number?,
}

t.describe('multi-line expected types', function()
	t.it('G equals Expected (alias the multi-line shape first)', function()
		t.expectType<<G>>():toEqualType<<Expected>>()
	end)

	t.it('G equals { name: string, price: number? } (single line)', function()
		t.expectType<<G>>():toEqualType<<{ name: string, price: number? }>>()
	end)
end)
