import type { ResolvedConfig } from "./resolved-config.ts";

/** The resolved settings one shadow tree is instrumented under. */
export type CoverageSettings = Pick<
	ResolvedConfig,
	| "collectCoverageFrom"
	| "coverageCache"
	| "coverageCopyIgnorePatterns"
	| "coveragePathIgnorePatterns"
	| "rootDir"
>;

/**
 * The coverage settings of one resolved config.
 * @param config - A package or run config, defaults already applied.
 * @returns Its coverage settings.
 */
export function pickCoverageSettings(config: ResolvedConfig): CoverageSettings {
	return {
		collectCoverageFrom: config.collectCoverageFrom,
		coverageCache: config.coverageCache,
		coverageCopyIgnorePatterns: config.coverageCopyIgnorePatterns,
		coveragePathIgnorePatterns: config.coveragePathIgnorePatterns,
		rootDir: config.rootDir,
	};
}
