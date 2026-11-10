--!strict
local RunOnce = require("./run-once")

type Config = RunOnce.Config

local module = {}

type ProjectEntry = {
	jestOutput: string,
	gameOutput: string,
	bannerOutput: string,
	elapsedMs: number,
	jobIndex: number?,
}

-- Per-config, not upfront: nested mounts with stubs present at once make
-- Jest's parent-traversal config lookup resolve the wrong config.
type RunHooks = {
	beforeConfig: ((cfg: Config, index: number) -> ())?,
	afterConfig: ((cfg: Config, index: number) -> ())?,
}

function module.runProjects(
	callingScript: LuaSourceContainer,
	configs: { Config },
	hooks: RunHooks?
): { ProjectEntry }
	local entries: { ProjectEntry } = {}
	local beforeConfig = if hooks then hooks.beforeConfig else nil
	local afterConfig = if hooks then hooks.afterConfig else nil

	for index, cfg in configs do
		local outcome = RunOnce.runEntry(callingScript, cfg, {
			-- VM hosts pass false: the coordinator's batch capture holds these.
			capture = cfg.runnerCaptureGameOutput ~= false,
			cleanUp = if afterConfig
				then function()
					afterConfig(cfg, index)
				end
				else nil,
			stage = if beforeConfig
				then function()
					beforeConfig(cfg, index)
				end
				else nil,
		})
		entries[index] = {
			jestOutput = outcome.jestOutput,
			gameOutput = outcome.gameOutput or "[]",
			bannerOutput = outcome.bannerOutput or "[]",
			elapsedMs = outcome.elapsedMs,
			jobIndex = cfg.runnerJobIndex,
		}
	end

	return entries
end

return module
