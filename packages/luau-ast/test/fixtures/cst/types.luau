--!strict
-- type aliases
type Simple = number
type Optional = string?
type Union = number | string | nil
type LeadingUnion = | number | string
type Intersection = { x: number } & { y: number }
type LeadingIntersection = & { x: number } & { y: number }
type Singleton = "literal" | 'single' | true | false
type Callback = (number, string) -> boolean
type NamedArgs = (first: number, second: string) -> ()
type Varargs = (...number) -> ...string
type MultiReturn = () -> (number, string)
type Table = { name: string, age: number }
type Array = { number }
type Indexer = { [string]: number }
type ReadOnly = { read x: number, write y: string }
type Nested = { list: { { value: number } } }
type Typeof = typeof(print)
type TypeofExpr = typeof(({ 1 }))
type Grouped = (number | string)
type Parenthesised = (number)
export type Exported = number
type Empty = {}
type Ref = Simple
type Qualified = Enum.KeyCode
type Alias = Ref?

-- generic aliases with defaults and packs
type Generic<T> = { value: T }
type TwoGenerics<K, V> = { [K]: V }
type Defaulted<T = string> = { value: T }
type MultiDefault<T = string, U = number> = { first: T, second: U }
type Pack<T...> = (T...) -> T...
type PackDefault<T... = ...number> = (T...) -> ()
type PackDefaultExplicit<T... = (string, number)> = (T...) -> ()
type Mixed<T, U... = ...string> = (T, U...) -> ()
type Instantiated = Generic<number>
type InstantiatedPack = Pack<number, string>
type GenericFn = <T>(T) -> T
type GenericFnPack = <T, U...>(T, U...) -> (T, U...)
type Spaced < T , U > = { [T]: U }

-- annotated locals and parameters
local annotated: number = 1
local optional: string? = nil
local union: number | string = 2
local table: { x: number } = { x = 1 }
local callback: (number) -> string = tostring
local generic: Generic<number> = { value = 1 }
local a: number, b: string = 1, "s"

local function typed(first: number, second: string): boolean
	return first > 0
end
local function multi(first: number): (number, string)
	return first, "s"
end
local function packReturn(...: number): ...number
	return ...
end
local function genericFn<T>(value: T): T
	return value
end
local function genericPack<T, U...>(first: T, ...: U...): (T, U...)
	return first, ...
end
local function parenReturnUnion(): ((number) -> string) | nil
	return nil
end
local function noReturn(): ()
end
local function nilReturn(): nil
	return nil
end
local anonymousTyped = function(x: number): number return x end
local anonymousGeneric = function<T>(x: T): T return x end

-- assertions and casts
local asserted = annotated :: number
local castTable = table :: { x: number }
local castFn = callback :: (number) -> string
local castGeneric = generic :: Generic<number>
local castUnion = union :: number | string

-- multi-line types
type Multiline = {
	first: number,
	second: string,
	-- comment inside
	third: boolean;
	fourth: {
		nested: number,
	},
}
type MultilineFn = (
	first: number,
	second: string
) -> (
	number,
	string
)

return { annotated, optional, union, table, callback, generic, a, b, typed, multi, packReturn, genericFn, genericPack, parenReturnUnion, noReturn, nilReturn, anonymousTyped, anonymousGeneric, asserted, castTable, castFn, castGeneric, castUnion }
