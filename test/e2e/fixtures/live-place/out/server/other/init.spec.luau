-- Compiled with sloptor v3.0.0-beta.4
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _jest_globals = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "jest-globals", "src")
local describe = _jest_globals.describe
local expect = _jest_globals.expect
local it = _jest_globals.it
-- The namesake of `../namesake/index.spec.ts`. A run narrowed to that file must
-- leave this one out.
describe("other namesake spec", function()
	it("stays out of a run narrowed to its namesake", function()
		expect(2 + 2).toBe(4)
	end)
end)
