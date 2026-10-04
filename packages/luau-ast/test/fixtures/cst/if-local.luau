-- `if local` and `if const` bind the condition for the then branch only.
if local found = lookup() then
	print(found)
elseif const other : number  =  fallback() then
	print(other)
else
	print("none")
end

local label = if local name: string = getName() then name elseif const id = getId() then id else "anonymous"
