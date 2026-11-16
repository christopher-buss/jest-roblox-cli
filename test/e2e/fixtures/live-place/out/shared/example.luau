-- Compiled with sloptor v3.0.0-beta.4
local function add(a, b)
	return a + b
end
local function subtract(a, b)
	return a - b
end
-- One branch per `it.each` row in example.spec.ts: attribution records a test
-- only when it covers a statement no earlier test reached, so each row needs
-- a statement of its own.
local function sign(n)
	if n < 0 then
		return "negative"
	end
	if n > 0 then
		return "positive"
	end
	return "zero"
end
return {
	add = add,
	subtract = subtract,
	sign = sign,
}
