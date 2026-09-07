-- Rebuilds the Code Bundle a task carries in its `BinaryInput` buffer, over the
-- Harness Place that holds everything else.
--
-- Runs above the generated runner, so every module the run requires is in the
-- DataModel by the time Jest resolves anything.
--
-- Self-contained on purpose: one `do` block, no `require`, no name left behind.
-- The host splices it into a task script it did not write, behind that script's
-- leading `--!` directives, so it must not disturb what follows it.
do
	local SUPPORTED_BUNDLE_VERSION = 1

	local HttpService = game:GetService("HttpService")

	local taskInput = ({ ... })[1]
	local bundle = HttpService:JSONDecode(buffer.tostring(taskInput.BinaryInput))

	-- Both versions, because either half alone leaves the reader guessing which
	-- side is behind: the CLI that built the bundle, or the task script it
	-- generated.
	if bundle.version ~= SUPPORTED_BUNDLE_VERSION then
		error(
			string.format(
				"jest-roblox: cannot rebuild code bundle version %s — this task rebuilds version %d. "
					.. "The bundle and the task script must come from one install of the CLI.",
				tostring(bundle.version),
				SUPPORTED_BUNDLE_VERSION
			),
			0
		)
	end

	local function create(className: string, name: string, parent: Instance, source: string?)
		local instance = Instance.new(className)
		instance.Name = name
		if source ~= nil then
			(instance :: any).Source = source
		end

		instance.Parent = parent
		return instance
	end

	-- The instance a mount rebuilds onto. A mount with no explicit children in
	-- the project is exactly its directory, so what the place holds under that
	-- name is replaced whole and nothing stale survives. A mount the project
	-- declares children beside — a demoted coverage mount, a directory with a
	-- config stub under it — merges instead: those children may be mounts that
	-- stayed in the place, so the instance is kept and only what the bundle
	-- carries is replaced. A root whose class changed is rebuilt either way,
	-- and a merging one inherits the children it had.
	local function mountRoot(parent: Instance, name: string, mount)
		local root = mount.root
		local existing = parent:FindFirstChild(name)
		if existing ~= nil and mount.merge and existing.ClassName == root.className then
			if root.source ~= nil then
				(existing :: any).Source = root.source
			end

			return existing
		end

		local rebuilt = create(root.className, name, parent, root.source)
		if existing ~= nil then
			if mount.merge then
				for _, child in existing:GetChildren() do
					child.Parent = rebuilt
				end
			end

			existing:Destroy()
		end

		return rebuilt
	end

	-- Mounts arrive shallowest first, so a nested mount is rebuilt after the
	-- mount it sits under rather than being wiped by it.
	for _, mount in bundle.mounts do
		local segments = mount.dataModelPath
		local parent: Instance = game:GetService(segments[1] :: any)
		for index = 2, #segments - 1 do
			local child = parent:FindFirstChild(segments[index])
			parent = child or create("Folder", segments[index], parent)
		end

		local root = mountRoot(parent, segments[#segments], mount)

		-- Entries arrive shallowest first too, so the parent of the entry being
		-- created has always been created already. A directory holding
		-- `init.luau` is one of those parents: it is a ModuleScript, and a
		-- descendant created before it would leave a Folder in its place.
		--
		-- A top-level entry replaces the same-named child the root already
		-- holds; anything deeper lands under an instance this loop created.
		local byPath: { [string]: Instance } = { [""] = root }
		for _, entry in mount.entries do
			-- An entry path is slash-joined, because a rojo file stem cannot
			-- hold a slash. Only the last separator matters, so it is matched
			-- rather than split: a bundle carries thousands of these, and a
			-- table per entry is a table per file in the run.
			local parentPath, name = string.match(entry.path, "^(.*)/([^/]+)$")
			if name == nil then
				parentPath, name = "", entry.path
			end

			local entryParent = byPath[parentPath]
			if parentPath == "" then
				local stale = entryParent:FindFirstChild(name)
				if stale ~= nil then
					stale:Destroy()
				end
			end

			byPath[entry.path] = create(entry.className, name, entryParent, entry.source)
		end
	end
end
