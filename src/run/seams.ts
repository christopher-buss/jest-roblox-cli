import { resolveBackendAsync } from "../backends/auto.ts";
import { resolveAllProjects } from "../config/projects.ts";
import { createSetupResolver } from "../config/setup-resolver.ts";
import { prepareCoverageAsync } from "../coverage-pipeline/prepare.ts";
import { type RunProjects, runProjectsAsync } from "../executor.ts";
import type { TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { nodeTsconfigReader } from "../executor/tsconfig-mappings.ts";
import { type RunTypecheck, runTypecheckAsync } from "../typecheck/runner.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";

/** Everything a run reaches outside itself through, beyond the filesystem. */
export interface RunSeams {
	childProcess: ChildProcessRunner;
	createSetupResolver: typeof createSetupResolver;
	prepareCoverage: typeof prepareCoverageAsync;
	resolveAllProjects: typeof resolveAllProjects;
	resolveBackend: typeof resolveBackendAsync;
	runProjects: RunProjects;
	runTypecheck: RunTypecheck;
	/** `get-tsconfig` owns its own fs handle. */
	tsconfigReader: TsconfigReader;
}

// A member read at module-evaluation time binds `undefined` across the import
// cycle under `prepareCoverage`.
/** The real stages, for every caller that is not a test. */
export function nodeRunSeams(): RunSeams {
	return {
		childProcess: nodeChildProcessRunner,
		createSetupResolver,
		prepareCoverage: prepareCoverageAsync,
		resolveAllProjects,
		resolveBackend: resolveBackendAsync,
		runProjects: runProjectsAsync,
		runTypecheck: runTypecheckAsync,
		tsconfigReader: nodeTsconfigReader,
	};
}
