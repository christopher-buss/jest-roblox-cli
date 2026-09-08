-- explicit type instantiation
local function f<T, U...>(...: U...) return ... end
local a = f<<number, string>>(1)
local b = f<< number >>
local c = f<<{ x: number }, ...string>>()
local d = f<<(number) -> string>>
return a, b, c, d
