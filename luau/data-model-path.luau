--!strict
-- The path form every per-test hook reports an Instance in.
--
-- Its own module because two hooks need it — per-test coverage attribution and
-- the wedge heartbeat — and both are read by the host's source mapper, which
-- resolves exactly this form. A second copy would let one drift from what the
-- mapper resolves while the other still worked.

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
