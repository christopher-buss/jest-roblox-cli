local log = {}

local function note(tag, value)
	table.insert(log, tag)
	return value
end

local andResult = note("L1", true) and note("R1", 42)
local orResult = note("L2", false) or note("R2", 99)

print(table.concat(log, ","))
print(tostring(andResult))
print(tostring(orResult))
