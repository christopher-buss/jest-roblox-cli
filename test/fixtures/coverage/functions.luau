local function greet(name)
    return "Hello, " .. name
end

local handler = function(x)
    return x * 2
end

function globalFunc()
    print("global")
end

greet("world")
handler(5)
globalFunc()
