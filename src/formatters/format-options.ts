import type { ResolvedConfig } from "../config/schema.ts";
import type { FormatOptions } from "./shared.ts";

/**
 * The `FormatOptions` fields every render site reads straight off the config.
 */
export type ConfigFormatOptions = Pick<
	FormatOptions,
	| "collectCoverage"
	| "color"
	| "rootDir"
	| "showLuau"
	| "slowTestThreshold"
	| "verbose"
	| "version"
>;

/**
 * The config-derived half of `FormatOptions`, shared by the three render sites
 * (executor single-project output, and the combined and multi-project prints).
 * Each spreads this and adds only what it alone knows — the source mapper, the
 * snapshot-write tally, the type-error count, the resolved sink paths.
 */
export function toFormatOptions(config: ResolvedConfig, version: string): ConfigFormatOptions {
	return {
		collectCoverage: config.collectCoverage,
		color: config.color,
		rootDir: config.rootDir,
		showLuau: config.showLuau,
		slowTestThreshold: config.slowTestThreshold,
		verbose: config.verbose,
		version,
	};
}
