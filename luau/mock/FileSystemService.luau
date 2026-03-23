--!strict
local function normalizeSnapPath(path: string): string
	return (string.gsub(path, "%.snap%.lua$", ".snap.luau"))
end

local function create(snapshotWrites: { [string]: string })
	local FileSystemService = {}

	function FileSystemService:WriteFile(path: string, contents: string)
		snapshotWrites[normalizeSnapPath(path)] = contents
	end

	function FileSystemService:CreateDirectories(_path: string) end

	function FileSystemService:Exists(path: string): boolean
		return snapshotWrites[normalizeSnapPath(path)] ~= nil
	end

	function FileSystemService:Remove(path: string)
		snapshotWrites[normalizeSnapPath(path)] = nil
	end

	function FileSystemService:IsRegularFile(path: string): boolean
		return snapshotWrites[normalizeSnapPath(path)] ~= nil
	end

	return FileSystemService
end

return create
