local a, b, c = 1, 2, 3

-- parentheses and precedence
local grouped = (a + b) * c
local nested = ((a))
local redundant = (a) + (b)
local chain = a + b - c * a / b % c ^ a // b .. "s"
local comparisons = a < b and a <= b or a > b and a >= b or a == b and a ~= b
local unary = -a + not b + #"len" - - a
local rightAssoc = a ^ b ^ c
local concat = "a" .. "b" .. "c"

-- tables
local emptyTable = {}
local list = { 1, 2, 3 }
local record = { x = 1, y = 2 }
local general = { [1] = "one", ["two"] = 2, [a + b] = c }
local mixed = { 1, x = 2, [3] = 3; 4; y = 5, }
local trailingSemicolon = { 1; 2; }
local nestedTable = { inner = { deep = { 1 } } }
local multiline = {
	first = 1,
	second = 2,
	-- comment inside
	third = 3,
}

-- calls
local function f(...) return ... end
local callParens = f(1, 2, 3)
local callEmpty = f()
local callString = f "string"
local callLong = f [[long]]
local callTable = f { 1, 2 }
local callChained = f(f(1))(2)
local method = ("x"):rep(2)
local obj = { m = function(self, v) return v end }
local methodCall = obj:m(1)
local methodString = obj:m "s"
local methodTable = obj:m {}

-- indexing
local t = { x = { y = { z = 1 } } }
local dotted = t.x.y.z
local bracket = t["x"]["y"]["z"]
local mixedIndex = t.x["y"].z
local callIndex = f(t).x
local multilineIndex = t
	.x
	.y
	.z

-- varargs and functions
local function variadic(first, ...)
	local packed = { ... }
	local count = select("#", ...)
	return first, ...
end
local anonymous = function(x, y) return x + y end
local noParams = function() end
local nestedFn = function() return function() return 1 end end

-- if expressions
local ifExpr = if a then b else c
local ifElseif = if a == 1 then "one" elseif a == 2 then "two" elseif a == 3 then "three" else "many"
local ifNested = if a then (if b then 1 else 2) else 3
local ifElseIf = if a then 1 else if b then 2 else 3

-- type assertions
local asserted = a :: number
local assertedGroup = (a + b) :: number
local chainedAssert = (a :: any) :: number

return grouped, nested, redundant, chain, comparisons, unary, rightAssoc, concat, emptyTable, list, record, general, mixed, trailingSemicolon, nestedTable, multiline, callParens, callEmpty, callString, callLong, callTable, callChained, method, methodCall, methodString, methodTable, dotted, bracket, mixedIndex, callIndex, multilineIndex, variadic, anonymous, noParams, nestedFn, ifExpr, ifElseif, ifNested, ifElseIf, asserted, assertedGroup, chainedAssert
