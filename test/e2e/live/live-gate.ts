import process from "node:process";

/** Whether the specs in this directory reach real Open Cloud. */
export const IS_LIVE = process.env["JEST_ROBLOX_LIVE"] === "1";

/**
 * The credentials a spawned CLI needs to reach real Open Cloud. Passed through
 * rather than read from `process.env` by the child, because `runCliAsync`
 * builds the child's environment from an allow-list that deliberately excludes
 * them — a spec that wants the live wire has to say so.
 */
export function liveEnvironment(): Record<string, string | undefined> {
	return {
		JEST_ROBLOX_LIVE: process.env["JEST_ROBLOX_LIVE"],
		ROBLOX_OPEN_CLOUD_API_KEY: process.env["ROBLOX_OPEN_CLOUD_API_KEY"],
		ROBLOX_PLACE_ID: process.env["ROBLOX_PLACE_ID"],
		ROBLOX_UNIVERSE_ID: process.env["ROBLOX_UNIVERSE_ID"],
	};
}
