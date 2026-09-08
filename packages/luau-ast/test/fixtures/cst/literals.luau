-- every number spelling
local integers = { 0, 1, 42, 1_000_000, 0x1F, 0XfF, 0xFF_FF, 0b1010, 0B11_00 }
local floats = { 1.5, .5, 5., 1e10, 1E-3, 1.5e+2, 3.14_15 }
local negatives = { -1, -1.5, - 2 }

-- every string spelling
local double = "double \"quoted\" \n \t \\ \x41 \u{1F600} \65"
local single = 'single \'quoted\''
local continued = "line \z
	continued"
local long = [[long
string]]
local levelled = [==[levelled ]] string]==]
local empty = ""
local emptyLong = [[]]

-- interpolated strings
local name = "world"
local plain = `no interpolation`
local simple = `hello {name}`
local spaced = `hello { name } and { 1 + 2 }!`
local nested = `outer {`inner {name}`} done`
local braces = `literal \{ brace`
local multiline = `first {name}\nsecond {name}`

-- booleans and nil
local t, f, n = true, false, nil

return { integers, floats, negatives, double, single, continued, long, levelled, empty, emptyLong, plain, simple, spaced, nested, braces, multiline, t, f, n }
