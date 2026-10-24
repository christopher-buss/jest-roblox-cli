--!strict
export type Config = { name: string }
local function defineConfig(c: Config): Config
	return c
end
return { defineConfig = defineConfig }
