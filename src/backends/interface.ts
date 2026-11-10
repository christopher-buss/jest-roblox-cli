import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import type { GapRecord } from "../gaps/gap-types.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { PerTestCoverageEntry } from "../protocol/coverage.ts";
import type { EnvelopeEntry } from "../protocol/envelope.ts";
import type { SnapshotWrites } from "../protocol/runner-fields.ts";
import type { JestArgv } from "../runner-payload/jest-argv.ts";
import type { JestResult } from "../types/jest-result-types.ts";

/** A shard request: a session count, `"auto"`, or unset for one session. */
export type ParallelOption = "auto" | number | undefined;

/** Settings that hold for the whole run, not per job. */
export type RunSettings = Pick<
	ResolvedConfig,
	"bootProbeTimeout" | "placeFile" | "rootDir" | "timeout" | "uploadCache"
>;

/** One project the backend must run. */
export interface ProjectJob {
	/** The argv the runner runs the project with. */
	argv: JestArgv;
	/** Color for the project label in the reporter. */
	displayColor?: string | undefined;
	/** Name that labels the project's results. */
	displayName: string;
	/** Workspace-mode npm package that owns this project. */
	pkg?: string | undefined;
	/** Studio-only DataModel paths that get a runtime `jest.config` stub. */
	runtimeInjectionPaths?: Array<string> | undefined;
	/** Test files to run for the project. */
	testFiles: Array<string>;
}

/** What every backend's dispatch request carries. */
export interface DispatchBase {
	/** Projects to run, in order. */
	jobs: NonEmptyArray<ProjectJob>;
	/** Receives the stages only the backend can see. */
	progress?: RunProgress | undefined;
	/** Run-wide settings, the same for every job. */
	runSettings: RunSettings;
}

/** Time the backend spent on the run. */
export interface BackendTiming {
	/** Time spent in execution, in milliseconds. */
	executionMs: number;
	/** Time spent uploading the place, in milliseconds. */
	uploadMs?: number | undefined;
}

/** Parsed result of one project. */
export interface ProjectBackendResult {
	/** Raw coverage hits the project recorded. */
	coverageData?: RawCoverageData | undefined;
	/** Game output captured while the project ran. */
	gameOutput?: string | undefined;
	/** `"batch"` when the game output is the whole run's capture. */
	gameOutputScope?: "batch" | undefined;
	/** Coverage hits recorded per test. */
	perTestCoverage?: Array<PerTestCoverageEntry> | undefined;
	/** Parsed Jest result. */
	result: JestResult;
	/** Time spent on setup before the tests, in milliseconds. */
	setupMs?: number | undefined;
	/** Snapshot files the project wrote. */
	snapshotWrites?: SnapshotWrites | undefined;
}

/** One envelope entry as the backend received it, before parsing. */
export interface RawBackendEntry {
	/** Envelope entry as the task returned it. */
	entry: EnvelopeEntry;
	/** Game output to use when the entry carries none. */
	fallbackGameOutput?: string | undefined;
	/** Carried from the envelope; see {@link ProjectBackendResult}. */
	gameOutputScope?: "batch" | undefined;
	/** Emulation gaps the entry raised. */
	gaps?: GapRecord | undefined;
	/** Index of the job the entry answers. */
	jobIndex: number;
}

/** Raw output of one backend run. */
export interface BackendResult {
	/**
	 * A task stopped under `--bail`, so the jobs it never reached have no
	 * entry.
	 */
	bailed?: boolean | undefined;
	/** One raw entry per job that ran, in any order. */
	rawResults: Array<RawBackendEntry>;
	/** Time the backend spent on the run. */
	timing: BackendTiming;
}

/** Backend that runs the tests. */
export type BackendKind = "open-cloud" | "studio" | "studio-cli";

/**
 * Runs test jobs in one execution environment, from its own request type.
 * @template Kind - Which backend this is.
 * @template Request - The dispatch request the backend takes.
 */
export interface BackendOf<Kind extends BackendKind, Request extends DispatchBase> {
	/** Releases resources the backend holds. */
	closeAsync?(): Promise<void> | void;
	/** Which backend this is; picks the request type. */
	readonly kind: Kind;
	/**
	 * Runs the jobs and collects their raw results.
	 * @param request - Jobs and run settings.
	 * @returns Raw entries and timing of the run.
	 */
	runTestsAsync(request: Request): Promise<BackendResult>;
}

type NonEmptyArray<T> = [T, ...Array<T>];

/**
 * Whether the request shards across more than one session.
 * @param parallel - Requested shard count.
 * @returns True for `"auto"` or a count above 1.
 */
export function isShardedParallel(parallel: ParallelOption): parallel is "auto" | number {
	return parallel === "auto" || (typeof parallel === "number" && parallel > 1);
}

/**
 * The run-wide settings a config holds.
 * @param config - Config the run reads its settings from.
 * @returns Settings the backends read once per run.
 */
export function pickRunSettings({
	bootProbeTimeout,
	placeFile,
	rootDir,
	timeout,
	uploadCache,
}: ResolvedConfig): RunSettings {
	return {
		bootProbeTimeout,
		placeFile,
		rootDir,
		timeout,
		uploadCache,
	};
}
