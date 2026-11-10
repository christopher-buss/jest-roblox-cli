import type { ResolvedConfig } from "../config/resolved-config.ts";
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
 * The config-derived half of `FormatOptions`.
 * @param config - Resolved CLI config.
 * @param version - CLI version for the header.
 * @returns The config-derived format options.
 */
export function toFormatOptions(
	config: Pick<
		ResolvedConfig,
		"collectCoverage" | "color" | "rootDir" | "showLuau" | "slowTestThreshold" | "verbose"
	>,
	version: string,
): ConfigFormatOptions {
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
