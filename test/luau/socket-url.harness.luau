--!nocheck
local socketUrl = __MODULE__
local Protocol = __PROTOCOL_MODULE__

local function checkEqual(actual: any, expected: any, message: string)
	if actual ~= expected then
		error(message .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual), 0)
	end
end

local function attributes(values: { [string]: any }): (string) -> any
	return function(name: string): any
		return values[name]
	end
end

checkEqual(
	socketUrl(Protocol.studio, attributes({})),
	"ws://localhost:" .. tostring(Protocol.studio.defaultPort),
	"an unset attribute dials the default port"
)
checkEqual(
	socketUrl(Protocol.studio, attributes({ [Protocol.studio.portAttribute] = 4123 })),
	"ws://localhost:4123",
	"the port attribute picks the port"
)
checkEqual(
	socketUrl(Protocol.studio, attributes({ [Protocol.studio.portAttribute] = "4123" })),
	"ws://localhost:" .. tostring(Protocol.studio.defaultPort),
	"a non-number attribute falls back to the default"
)

print("ALL OK")
