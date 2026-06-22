local log = {}

local function note(tag, value)
	table.insert(log, tag)
	return value
end

local andResult = note("L1", false) and note("R1", true)
local orResult = note("L2", true) or note("R2", false)

print(table.concat(log, ","))
print(tostring(andResult))
print(tostring(orResult))
