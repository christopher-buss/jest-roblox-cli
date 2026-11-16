-- Compiled with sloptor v3.0.0-beta.4
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _jest_globals = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "jest-globals", "src")
local describe = _jest_globals.describe
local expect = _jest_globals.expect
local it = _jest_globals.it
local _example = TS.import(script, game:GetService("ReplicatedStorage"), "PkgShared", "example")
local add = _example.add
local sign = _example.sign
local subtract = _example.subtract
-- The three call shapes whose call site the runtime reads differently: a bare
-- `it`, one inside a `describe`, and an `it.each` table. The live e2e in
-- test/e2e/live/pipeline.spec.ts asserts each one's recorded location is
-- its own `it(` line in this file. Each test covers a statement no other test
-- reaches, because attribution records a test only for statements it covered
-- first.
it("subtracts at the top level", function()
	expect(subtract(3, 1)).toBe(2)
end)
describe("shared example", function()
	it("adds two numbers", function()
		-- Game-output regression marker. Asserted by the live e2e in
		-- test/e2e/live/pipeline.spec.ts: native `warn` must land in
		-- the `--gameOutput` JSON dump (LogService capture path).
		warn("game-output marker")
		expect(add(2, 3)).toBe(5)
	end)
	-- One `%s` only: jest-roblox fills mixed `%i`/`%s` placeholders out of order.
	it.each({ "negative", "positive" })("signs a %s number", function(kind)
		expect(sign(if kind == "negative" then -1 else 1)).toBe(kind)
	end)
end)
