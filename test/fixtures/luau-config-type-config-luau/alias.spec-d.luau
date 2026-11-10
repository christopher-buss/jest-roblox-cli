--!strict
local function describe(_name: string, body: () -> ()) body() end
local function it(_name: string, body: () -> ()) body() end

local jest = require("@jest-roblox/config")

describe("Config", function()
	it("accepts a valid config", function()
		local _config = jest.defineConfig({ placeFile = "game.rbxl" })
	end)

	it("rejects an unknown root key", function()
		-- @expect-error
		local _config = jest.defineConfig({ placeFiles = "game.rbxl" })
	end)
end)
