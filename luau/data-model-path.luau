--!strict
-- Wire contract: the host's source mapper resolves exactly this path form.

return function(instance: Instance): string
	local parts: { string } = {}
	local current: Instance? = instance
	while current and current.Parent ~= nil do
		table.insert(parts, current.Name)
		current = current.Parent
	end

	local left, right = 1, #parts
	while left < right do
		parts[left], parts[right] = parts[right], parts[left]
		left += 1
		right -= 1
	end

	return table.concat(parts, "/")
end
