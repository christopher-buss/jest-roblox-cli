local function check(value)
	-- cov ignore if
	if not value then
		error("unreachable")
	end
	-- cov ignore else
	if value > 1 then
		print("big")
	elseif value > 0 then
		print("small")
	else
		print("dead")
	end
	return value
end

-- cov ignore next
local function unused()
	return 0
end

print(check(2))
