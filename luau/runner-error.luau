--!strict
local module = {}

type Coded = { code: string, message: string }

local CODED = {
	__tostring = function(self: Coded): string
		return self.message
	end,
}

function module.raise(code: string, message: string): never
	error(setmetatable({ code = code, message = message }, CODED), 0)
end

function module.codeOf(err: any): string?
	if type(err) == "table" and getmetatable(err) == CODED then
		return err.code
	end

	return nil
end

return module
