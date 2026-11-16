-- Compiled with sloptor v3.0.0-beta.4
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _jest_globals = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "jest-globals", "src")
local describe = _jest_globals.describe
local expect = _jest_globals.expect
local it = _jest_globals.it
local multiply = TS.import(script, game:GetService("ServerScriptService"), "PkgServer", "server-thing").multiply
describe("server thing", function()
	it("multiplies two numbers", function()
		expect(multiply(3, 4)).toBe(12)
	end)
end)
