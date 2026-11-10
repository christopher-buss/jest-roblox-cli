import { pickCoverageSettings } from "../config/coverage-settings.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { ShadowBake } from "../shadow/spine.ts";
import { createStubBake } from "../shadow/stub-shadow-sync.ts";
import type { FileSystem } from "../utils/file-system.ts";

interface ProjectCoverageInput {
	cacheRoot: string;
	fileSystem: FileSystem;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

interface ProjectCoveragePlan {
	bake: ShadowBake;
	coverageInclude: Array<string> | undefined;
}

/**
 * Instrumentation uses the same coverage settings as the workspace and report.
 * The bake's ownership and writes must stay paired through shadow reconciliation.
 * @param input - Resolved projects, configuration and stub cache.
 * @returns Coverage inputs for the staging caller to execute.
 */
export function buildProjectCoveragePlan(input: ProjectCoverageInput): ProjectCoveragePlan {
	return {
		bake: createStubBake(input),
		coverageInclude: pickCoverageSettings(input.rootConfig).collectCoverageFrom,
	};
}
