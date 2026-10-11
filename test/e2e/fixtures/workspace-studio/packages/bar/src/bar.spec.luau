local ReplicatedStorage = game:GetService("ReplicatedStorage")

local JestGlobals = require(ReplicatedStorage.Packages.JestGlobals)
local Bar = require(script.Parent)

local expect = JestGlobals.expect
local it = JestGlobals.it

it("should load bar", function()
	expect(Bar.name).toBe("bar")
end)
