-- Compiled with sloptor v3.0.0-beta.4
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _jest_globals = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "jest-globals", "src")
local describe = _jest_globals.describe
local expect = _jest_globals.expect
local it = _jest_globals.it
-- Sits at `nested/namesake`, so the path of `../../namesake/index.spec.ts` is a
-- bare suffix of this one's. A run narrowed to that file must leave this out,
-- which only holds while the forwarded pattern carries the mount's own name.
describe("nested namesake spec", function()
	it("stays out of a run narrowed to the shallower namesake", function()
		expect(3 + 3).toBe(6)
	end)
end)
