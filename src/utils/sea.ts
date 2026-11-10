import process from "node:process";

const SEA_ENV = "JEST_ROBLOX_SEA";

/** Mark this process as the single-executable build. */
export function markSeaBuild(): void {
	process.env[SEA_ENV] = "true";
}

/**
 * Whether this process runs as the single-executable build.
 * @returns True inside the SEA binary.
 */
export function isSeaBuild(): boolean {
	return process.env[SEA_ENV] === "true";
}
