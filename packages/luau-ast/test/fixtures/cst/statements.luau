local x = 1;
local y, z = 2, 3;
local declaredOnly
local annotated: number = 4
local a: number, b: string = 5, "s";

-- assignment
x = 2
x, y = y, x
z = x; y = z
local t = {}
t.field = 1
t["key"] = 2
t.nested = { inner = 1 }
t.nested.inner = 3

-- compound assignment
x += 1
x -= 1
x *= 2
x /= 2
x //= 2
x %= 3
x ^= 2
t.field ..= "s"
t["key"] += 1

-- do block
do
	local inner = 1
	x = inner
end
do end

-- while
while x < 10 do
	x += 1
end
while true do break end

-- repeat
repeat
	x -= 1
until x <= 0
repeat until true

-- if
if x then
	y = 1
end
if x then y = 1 else y = 2 end
if x == 1 then
	y = 1
elseif x == 2 then
	y = 2
elseif x == 3 then
	y = 3
else
	y = 4
end
if x then
	if y then
		z = 1
	else
		z = 2
	end
end

-- numeric for
for i = 1, 10 do
	x += i
end
for i = 10, 1, -1 do
	x -= i
end
for i: number = 1, 2 do end
for _ = 1, 3 do continue end

-- generic for
for k, v in pairs(t) do
	x += 1
end
for i, v in ipairs({ 1, 2 }) do end
for k in next, t do end
for a: number, b: string in pairs(t) do end
for _, v in t do
	if v then
		break
	end
	continue
end

-- functions
function globalFunction() end
function t.method(self) end
function t.nested.deep(a, b) return a + b end
function t:method(a, ...)
	return self, a, ...
end
local function localFunction(a, b)
	return a + b
end
local function recursive(n)
	if n <= 0 then return 0 end
	return recursive(n - 1)
end
function t.multiline(
	first,
	second
)
	return first, second
end;

-- return forms
local function returnsNothing()
	return
end
local function returnsMany()
	return 1, 2, 3
end
local function returnsCall()
	return returnsMany()
end
local function returnsSemicolon()
	return 1;
end

-- expression statements
print("hello")
t:method()
;(print)("parenthesised call statement")
;(function() end)()


-- const locals
const constant = 3
const function constFunction() end

return x, y, z, a, b, t, globalFunction, localFunction, recursive, returnsNothing, returnsMany, returnsCall, returnsSemicolon, declaredOnly, annotated
