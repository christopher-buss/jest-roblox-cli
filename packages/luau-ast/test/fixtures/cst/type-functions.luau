-- type functions
type function Identity(t)
	return t
end
export type function Exported(t: type)
	return t
end
type function OneLine(t) return t end;
export type function ExportedSemicolon(t) return t end;

-- typeof over locals
local value = { field = 1 }
type UsesTypeof = typeof(value)
type UsesTypeofIndex = typeof(value.field)
type UsesTypeofCall = typeof(print(value))
type UsesTypeofSpaced = typeof( value )
local typed: typeof(value) = { field = 2 }
local function returnsTypeof(): typeof(value)
	return typed
end
return returnsTypeof
