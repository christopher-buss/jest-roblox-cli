--!strict
type function Same(actual, expected)
	local assumed: { { any } } = {}

	local function isAssumed(a: any, b: any): boolean
		for _, pair in assumed do
			if pair[1] == a and pair[2] == b then
				return true
			end
		end
		return false
	end

	local function members(x: any, out: { any }): { any }
		if x.tag == "union" then
			for _, c in x:components() do
				members(c, out)
			end
		elseif x.tag == "boolean" then
			table.insert(out, types.singleton(true))
			table.insert(out, types.singleton(false))
		else
			table.insert(out, x)
		end
		return out
	end

	local eq: (any, any) -> boolean

	local function sameSet(as: { any }, bs: { any }): boolean
		for _, a in as do
			local found = false
			for _, b in bs do
				if eq(a, b) then
					found = true
					break
				end
			end
			if not found then
				return false
			end
		end
		for _, b in bs do
			local found = false
			for _, a in as do
				if eq(a, b) then
					found = true
					break
				end
			end
			if not found then
				return false
			end
		end
		return true
	end

	local function optEq(a: any, b: any): boolean
		if a == nil or b == nil then
			return a == nil and b == nil
		end
		return eq(a, b)
	end

	local function listEq(as: { any }?, bs: { any }?): boolean
		local la, lb = as or {}, bs or {}
		if #la ~= #lb then
			return false
		end
		for i = 1, #la do
			if not eq(la[i], lb[i]) then
				return false
			end
		end
		return true
	end

	local function packEq(a: any, b: any): boolean
		return listEq(a.head, b.head) and optEq(a.tail, b.tail)
	end

	local function withoutAnyTail(pack: any): any
		if pack.tail ~= nil and pack.tail.tag == "any" then
			return { head = pack.head }
		end
		return pack
	end

	local function tableEq(a: any, b: any): boolean
		local count = 0
		for key, pa in a:properties() do
			count += 1
			local pb = b:readproperty(key) ~= nil or b:writeproperty(key) ~= nil
			if not pb then
				return false
			end
			if not optEq(pa.read, b:readproperty(key)) or not optEq(pa.write, b:writeproperty(key)) then
				return false
			end
		end
		for _ in b:properties() do
			count -= 1
		end
		if count ~= 0 then
			return false
		end
		local ia, ib = a:indexer(), b:indexer()
		if ia == nil or ib == nil then
			if ia ~= nil or ib ~= nil then
				return false
			end
		elseif not (eq(ia.index, ib.index) and optEq(ia.readresult, ib.readresult) and optEq(ia.writeresult, ib.writeresult)) then
			return false
		end
		return optEq(a:metatable(), b:metatable())
	end

	local function functionEq(a: any, b: any): boolean
		local ga, gb = a:generics(), b:generics()
		if #ga ~= #gb then
			return false
		end
		for i = 1, #ga do
			table.insert(assumed, { ga[i], gb[i] })
		end
		return packEq(withoutAnyTail(a:parameters()), withoutAnyTail(b:parameters())) and packEq(a:returns(), b:returns())
	end

	eq = function(a: any, b: any): boolean
		if isAssumed(a, b) then
			return true
		end
		if a.tag == "union" or b.tag == "union" then
			return sameSet(members(a, {}), members(b, {}))
		end
		if a.tag ~= b.tag then
			return false
		end
		if a.tag == "singleton" then
			return a:value() == b:value()
		end
		if a.tag == "intersection" then
			return sameSet(a:components(), b:components())
		end
		if a.tag == "negation" then
			return eq(a:inner(), b:inner())
		end
		if a.tag == "table" then
			table.insert(assumed, { a, b })
			return tableEq(a, b)
		end
		if a.tag == "function" then
			table.insert(assumed, { a, b })
			return functionEq(a, b)
		end
		if a.tag == "generic" or a.tag == "class" or a.tag == "extern" then
			return a == b
		end
		return true
	end

	return types.singleton(eq(actual, expected))
end

export type function Eq(actual, expected)
	if Same(actual, expected):value() then
		return types.singleton(nil)
	end
	error(`Expected: {tostring(expected)}\nReceived: {tostring(actual)}`)
end

export type function NotEq(actual, expected)
	if not Same(actual, expected):value() then
		return types.singleton(nil)
	end
	error(`Expected a type other than: {tostring(expected)}`)
end

export type NeverMatchers<T> = {
	toEqualType: <U>(self: NeverMatchers<T>, NotEq<T, U>?) -> (),
	toEqualTypeOf: <U>(self: NeverMatchers<T>, U, NotEq<T, U>?) -> (),
}

export type Matchers<T> = {
	read _subject: T,
	never: NeverMatchers<T>,
	toEqualType: <U>(self: Matchers<T>, Eq<T, U>?) -> (),
	toEqualTypeOf: <U>(self: Matchers<T>, U, Eq<T, U>?) -> (),
	toExtend: <U>(self: { read _subject: U }) -> (),
}

local function expectTypeOf<T>(_value: T): Matchers<T>
	return nil :: any
end

local function expectType<T>(): Matchers<T>
	return nil :: any
end

local function describe(_name: string, _body: () -> ()) end

local function it(_name: string, _body: () -> ()) end

return { describe = describe, it = it, expectTypeOf = expectTypeOf, expectType = expectType }
