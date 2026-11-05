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
	/** Runs child processes. */
	childProcess: ChildProcessRunner;
	/** Builds the setup-file resolver. */
	createSetupResolver: typeof createSetupResolver;
	/** Prepares coverage instrumentation. */
	prepareCoverage: typeof prepareCoverageAsync;
	/** Resolves the project configs of a run. */
	resolveAllProjects: typeof resolveAllProjects;
	/** Resolves the backend to run on. */
	resolveBackend: typeof resolveBackendAsync;
	/** Runs the runtime projects. */
	runProjects: RunProjects;
	/** Runs the Type Test pass. */
	runTypecheck: RunTypecheck;
	/** `get-tsconfig` owns its own fs handle. */
	tsconfigReader: TsconfigReader;
}

/**
 * The real stages, for every caller that is not a test. A function, not a
 * constant: a member read at module-evaluation time binds `undefined` across
 * the import cycle under `prepareCoverage`.
 *
 * @returns Seams bound to the Node implementations.
 */
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
