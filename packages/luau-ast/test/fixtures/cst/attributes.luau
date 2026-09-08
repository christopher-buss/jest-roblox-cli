-- attributes, type functions, and declarations stay opaque slices for now
@native local function nativeLocal() end
@[native, checked] local function listed() end
@native @checked function twoBare() end
@native
function nextLine() end
local expression = @native function() end
@[ native ] function spaced() end

type function Identity(t)
	return t
end

declare declaredGlobal: number
declare function declaredFunction(x: number): string

return nativeLocal, listed, twoBare, nextLine, expression, spaced
