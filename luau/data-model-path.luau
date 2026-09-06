--!strict
-- The path form every per-test hook reports an Instance in.
--
-- Its own module because the form is a wire contract: the host's source mapper
-- resolves exactly this shape, so a hook that spelled it inline would drift
-- from what the mapper resolves without anything on this side noticing.

--[=[
	Service-rooted DataModel path, slash-joined.

	The `game` root is excluded, which is what "service-rooted" means here: its
	parent is nil, so the walk stops one short of it.

	@param instance -- The instance to name.
	@return Its path, e.g. `ReplicatedStorage/shared/foo.spec`.
]=]
return function(instance: Instance): string
	local parts: { string } = {}
	local current: Instance? = instance
	-- Appended and reversed rather than inserted at 1, which shifts every
	-- element already in the table on each step.
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
