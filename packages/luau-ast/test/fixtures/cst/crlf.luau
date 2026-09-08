-- crlf file
local x = 1 -- comment
--[[ block
spanning ]]
local function f(a: number, b)
	if a > b then
		return a
	elseif a == b then
		return b
	else
		return nil
	end
end

return f(x, 2)
