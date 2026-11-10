import { openBackend } from "../backends/open-backend.ts";
import { loadPackageConfigAsync, type PackageConfigLoader } from "../config/loader.ts";
import { resolveAllProjects } from "../config/projects.ts";
import { createSetupResolver } from "../config/setup-resolver.ts";
import { mapCoverageToTypeScript } from "../coverage-report/mapper.ts";
import { type ExecuteJobs, executeJobsAsync } from "../executor/executor.ts";
import { prepareCoverageAsync } from "../shadow/prepare.ts";
import { prepareWorkspaceCoverage } from "../shadow/workspace-prepare.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { nodeTsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { type RunTypecheck, runTypecheckAsync } from "../typecheck/runner.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";

/** Everything a run reaches outside itself through, beyond the filesystem. */
export interface RunSeams {
	/** Runs child processes. */
	childProcess: ChildProcessRunner;
	/** Builds the resolver that maps setup files to Instance paths. */
	createSetupResolver: typeof createSetupResolver;
	/** Loads one workspace package's config. */
	loadPackageConfig: PackageConfigLoader;
	/** Maps raw Luau hit counts onto TypeScript sources. */
	mapCoverage: typeof mapCoverageToTypeScript;
	/** Resolves, checks and builds the backend to run on. */
	openBackend: typeof openBackend;
	/** Prepares coverage instrumentation. */
	prepareCoverage: typeof prepareCoverageAsync;
	/** Prepares the coverage of the workspace packages. */
	prepareWorkspaceCoverage: typeof prepareWorkspaceCoverage;
	/** Resolves the project configs of a run. */
	resolveAllProjects: typeof resolveAllProjects;
	/** Dispatches built runtime jobs. */
	runProjects: ExecuteJobs;
	/** Runs the Type Test pass. */
	runTypecheck: RunTypecheck;
	/** `get-tsconfig` owns its own fs handle. */
	tsconfigReader: TsconfigReader;
}

/**
 * The real seams. A function, not a constant: the import cycle under
 * `prepareCoverage` binds `undefined` to a member read at module load.
 * @returns Seams bound to the Node implementations.
 */
export function nodeRunSeams(): RunSeams {
	return {
		childProcess: nodeChildProcessRunner,
		createSetupResolver,
		loadPackageConfig: loadPackageConfigAsync,
		mapCoverage: mapCoverageToTypeScript,
		openBackend,
		prepareCoverage: prepareCoverageAsync,
		prepareWorkspaceCoverage,
		resolveAllProjects,
		runProjects: executeJobsAsync,
		runTypecheck: runTypecheckAsync,
		tsconfigReader: nodeTsconfigReader,
	};
}
