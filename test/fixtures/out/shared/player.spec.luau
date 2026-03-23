-- Compiled with roblox-ts
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _0 = TS.import(script, script.Parent, "jest-globals")
local describe = _0.describe
local expect = _0.expect
local it = _0.it
local function createPlayer(name)
	return { name = name, stats = { health = 100 } }
end
describe("Player", function()
	it("should have correct name", function()
		local player = createPlayer("Alice")
		expect(player.name):toBe("Alice")
	end)
	expect(player.name):toBe("Alice")
	it("should never be zero", function()
		local health = 100
		expect(health).never:toBe(0)
	end)
	expect(health).never:toBe(0)
	it("should track scores", function()
		local scores = {}
		local _1 = { 10, 20 }
		for _, score in _1 do
			table.insert(scores, score)
			expect(score):toBeGreaterThan(0)
		end
		expect(score):toBeGreaterThan(0)
	end)
	it("should read optional stats", function()
		local player = createPlayer("Charlie")
		local _1 = player.stats
		if _1 ~= nil then
			_1 = _1.health
		end
		expect(_1):toBe(100)
		expect(_1):toBe(100)
	end)
	it("should match snapshot", function()
		local player = createPlayer("Dave")
		expect(player):toMatchSnapshot()
	end)
end)
