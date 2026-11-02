--!strict
local function describe(_name: string, body: () -> ()) body() end
local function it(_name: string, body: () -> ()) body() end

local jest = require("@jest-roblox/config")

describe("Config", function()
	it("accepts an empty config", function()
		local _config = jest.defineConfig({})
	end)

	it("accepts root, test and workspace keys", function()
		local _config = jest.defineConfig({
			backend = "open-cloud",
			extends = { "../jest.config.luau" },
			formatters = { "default", { "json", { outputFile = "out.json" } } },
			gameOutput = true,
			parallel = "auto",
			placeFile = "game.rbxl",
			test = {
				bail = 1,
				coverageReporters = { "text", "lcov" },
				coverageThreshold = { lines = 80 },
				displayName = { name = "root", color = "magenta" },
				projects = {
					"src/shared",
					{ test = { displayName = "client", include = { "src/client/**/*.spec.luau" } } },
				},
				snapshotFormat = { indent = 4 },
				testEnvironmentOptions = { url = "https://example.com" },
				testMatch = { "**/*.spec.luau" },
				testRegex = "%.spec$",
				typecheck = { enabled = true, include = { "**/*.spec-d.luau" } },
			},
			workspace = { gameOutput = true, packages = { "packages/*" }, root = "." },
		})
	end)

	it("accepts a cast to the Config type", function()
		local _config = {
			outputFile = "jest-output.json",
			test = { testTimeout = 10000 },
		} :: jest.Config
	end)
end)
