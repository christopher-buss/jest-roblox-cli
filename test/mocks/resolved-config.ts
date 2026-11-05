import process from "node:process";

import type { ResolvedConfig } from "../../src/config/schema.ts";

// jscpd:ignore-start
/**
 * Copies `DEFAULT_CONFIG` in src/config/schema.ts: unit helpers import no
 * production code.
 */
const DEFAULTS: ResolvedConfig = {
	backend: "auto",
	bootProbeTimeout: 90_000,
	collectCoverage: false,
	color: true,
	coverageCache: true,
	coverageCopyIgnorePatterns: ["**/*.d.ts", "**/*.d.ts.map", "**/*.luau.map"],
	coverageDirectory: "coverage",
	coveragePathIgnorePatterns: [
		"**/*.spec.lua",
		"**/*.spec.luau",
		"**/*.test.lua",
		"**/*.test.luau",
		"**/node_modules/**",
		"**/rbxts_include/**",
	],
	coverageReporters: ["text", "lcov"],
	passWithNoTests: false,
	placeFile: "./game.rbxl",
	port: 3001,
	projectTimeout: 60_000,
	rootDir: process.cwd(),
	showLuau: true,
	silent: false,
	sourceMap: true,
	testMatch: [
		"**/*.spec.ts",
		"**/*.spec.tsx",
		"**/*.test.ts",
		"**/*.test.tsx",
		"**/*.spec-d.ts",
		"**/*.test-d.ts",
		"**/*.spec-d.luau",
		"**/*.test-d.luau",
		"**/*.spec.lua",
		"**/*.spec.luau",
		"**/*.test.lua",
		"**/*.test.luau",
	],
	testPathIgnorePatterns: ["/node_modules/", "/dist/", "/out/"],
	timeout: 300_000,
	uploadCache: true,
	verbose: false,
};
// jscpd:ignore-end

export function createResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...structuredClone(DEFAULTS), ...overrides };
}
