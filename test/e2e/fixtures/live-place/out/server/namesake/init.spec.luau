-- Compiled with sloptor v3.0.0-beta.4
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _jest_globals = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "jest-globals", "src")
local describe = _jest_globals.describe
local expect = _jest_globals.expect
local it = _jest_globals.it
-- Paired with `../other/index.spec.ts`: both compile to an Instance named
-- `init.spec`, so a run narrowed to this file proves the forwarded pattern
-- carries path context rather than a bare basename.
describe("namesake spec", function()
	it("runs when narrowed to its own path", function()
		expect(1 + 1).toBe(2)
	end)
end)
