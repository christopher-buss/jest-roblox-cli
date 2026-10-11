local ReplicatedStorage = game:GetService("ReplicatedStorage")

local JestGlobals = require(ReplicatedStorage.Packages.JestGlobals)
local Foo = require(script.Parent)

local expect = JestGlobals.expect
local it = JestGlobals.it

it("should load foo", function()
	expect(Foo.name).toBe("foo")
end)
