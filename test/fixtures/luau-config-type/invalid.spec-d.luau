--!strict
local function describe(_name: string, body: () -> ()) body() end
local function it(_name: string, body: () -> ()) body() end

local jest = require("@jest-roblox/config")

describe("Config", function()
	it("rejects an unknown root key", function()
		-- @expect-error
		local _config = jest.defineConfig({ placeFiles = "game.rbxl" })
	end)

	it("rejects an unknown test key", function()
		-- @expect-error
		local _config = jest.defineConfig({ test = { testMatches = { "**/*.spec.luau" } } })
	end)

	it("rejects a backend that does not exist", function()
		-- @expect-error
		local _config = jest.defineConfig({ backend = "cloud" })
	end)

	it("rejects a string where a list goes", function()
		-- @expect-error
		local _config = jest.defineConfig({ test = { testMatch = "**/*.spec.luau" } })
	end)

	it("rejects a project without include", function()
		-- @expect-error
		local _config = jest.defineConfig({ test = { projects = { { test = { displayName = "a" } } } } })
	end)
end)
