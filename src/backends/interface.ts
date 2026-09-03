import type { ResolvedConfig } from "../config/schema.ts";
import type { PerTestCoverageEntry, RawCoverageData } from "../coverage-pipeline/types.ts";
import type {
	StreamingResultEntry,
	StreamingResultReader,
} from "../memory-store/sorted-map-client.ts";
import type { RunProgress } from "../progress/reporter.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import type { JestResult } from "../types/jest-result.ts";

/**
 * A shard request: an explicit session count, `"auto"` (the backend picks the
 * count the run needs), or unset for one session.
 */
export type ParallelOption = "auto" | number | undefined;

export interface EnvelopeEntry {
	bannerOutput?: string | undefined;
	elapsedMs?: number | undefined;
	gameOutput?: string | undefined;
	jestOutput: string;
	pkg?: string | undefined;
	project?: string | undefined;
	snapshotWrites?: SnapshotWrites | undefined;
}

export interface ProjectJob {
	config: ResolvedConfig;
	displayColor?: string | undefined;
	displayName: string;
	/**
	 * Workspace-mode only: the npm package name (e.g. `@halcyon/foo`) that
	 * owns this project. Combined with `displayName` it forms the lookup key
	 * used by work-stealing to match Luau-emitted entries to jobs. Outside
	 * workspace mode this is undefined and the lookup falls back to
	 * `displayName` alone.
	 */
	pkg?: string | undefined;
	/**
	 * Studio-only: filtered list of DataModel paths that should receive
	 * runtime `jest.config` ModuleScript injection. The CLI excludes mount
	 * paths where a user-authored `jest.config.luau` already exists on
	 * disk (synced by Rojo); injecting over those would either overwrite
	 * the canonical config or trigger the plugin's structural collision
	 * check. The Studio backend forwards this array (parallel to
	 * `configs`) as `runtimeStubMounts[i]` in the WebSocket payload; the
	 * plugin's Run Mode runner iterates only this list, never the
	 * unfiltered `cfg.projects`. Empty is meaningful — the project has no
	 * mounts needing runtime injection. Open-cloud backend ignores this
	 * field; it bakes stubs into the place file via the synthesizer.
	 */
	runtimeInjectionPaths?: Array<string> | undefined;
	testFiles: Array<string>;
}

export interface StreamingHooks {
	/**
	 * Called once per newly-observed SortedMap entry, in the order the
	 * backend's poll loop drains them. Duplicates from work-stealing
	 * fault-recovery are NOT filtered here — consumers handle that
	 * (the StreamingAggregator drops repeat pkg/project keys).
	 */
	onPackageResult: (entry: StreamingResultEntry) => void;
	/**
	 * Optional poll cadence in milliseconds. Defaults to 250ms — fast
	 * enough to feel live without saturating the Open Cloud rate limit.
	 */
	pollMs?: number | undefined;
	reader: StreamingResultReader;
}

export interface BackendOptions {
	jobs: Array<ProjectJob>;
	/**
	 * Open-Cloud-only: number of concurrent Open Cloud Luau execution sessions
	 * to fire. Unset or 1 means one session carrying all jobs. `"auto"`
	 * resolves to min(jobs.length, 3). studio-cli takes unset, 1, or `"auto"`
	 * and rejects an explicit count above 1; the attached `studio` backend
	 * ignores the field entirely.
	 */
	parallel?: ParallelOption;
	/**
	 * Where the backend announces the stages only it can see: the upload, the
	 * Boot Probe, and the dispatch window. Those sit inside `runTestsAsync`,
	 * which holds no timing collector, so they cannot reach the reporter the
	 * way a host phase does.
	 */
	progress?: RunProgress | undefined;
	/**
	 * Workspace mode, non-work-stealing only: rebuilds `scriptOverride` for a
	 * subset of jobs. A task that fills its return-envelope budget comes back
	 * having run only some of its entries; with no queue to leave the rest in,
	 * the backend sends a fresh task carrying exactly what did not run.
	 *
	 * Its presence is also what tells the backend this is a workspace run:
	 * every job shares one script, so splitting jobs into buckets would run
	 * the whole script once per bucket rather than dividing the work.
	 */
	scriptFactory?: ((jobs: ReadonlyArray<ProjectJob>) => string) | undefined;
	/**
	 * Workspace mode: pre-built Luau script that the backend should send
	 * verbatim instead of generating one from `jobs`. Used by the staged
	 * materializer pipeline so the CLI layer chooses the script and the
	 * backend stays unaware of the difference.
	 */
	scriptOverride?: string | undefined;
	/**
	 * Open-Cloud-only, work-stealing only: when provided, the backend polls
	 * the SortedMap concurrently with executeScript and invokes
	 * `onPackageResult` per newly-observed entry. Consumed entries are
	 * deleted to avoid re-emission. Streaming is best-effort: failure to
	 * poll/delete does not affect the final results returned in the task
	 * envelope.
	 */
	streaming?: StreamingHooks | undefined;
	/**
	 * Studio-only, experimental: how many Luau VMs (actor hosts in the plugin
	 * tree) the run-mode runner splits the configs across. `"auto"` means one
	 * VM per config. Unset — and any request that resolves to a single VM —
	 * runs the plain sequential path. The Open Cloud backend ignores it; the
	 * CLI rejects the combination before a run gets here.
	 */
	vmParallel?: ParallelOption;
	/**
	 * Open-Cloud-only: when true, fire `parallel` tasks all running the SAME
	 * `scriptOverride` (no static job-bucket split). Each task pulls work from
	 * a MemoryStore queue (set up upstream) and returns whatever subset of
	 * packages it processed. Backend aggregates entries across all task
	 * envelopes and maps each to the matching `ProjectJob.displayName` by the
	 * entry's `pkg` field. `scriptOverride` is required when this is true.
	 */
	workStealing?: boolean | undefined;
}

export interface BackendTiming {
	executionMs: number;
	uploadMs?: number | undefined;
}

export interface ProjectBackendResult {
	bannerOutput?: string | undefined;
	coverageData?: RawCoverageData | undefined;
	displayColor?: string | undefined;
	displayName: string;
	elapsedMs: number;
	gameOutput?: string | undefined;
	/**
	 * `"batch"` when this project's game output is the whole run's capture
	 * rather than its own — what an in-session parallel run reports, because
	 * `LogService` messages carry no project identity.
	 */
	gameOutputScope?: "batch" | undefined;
	luauTiming?: Record<string, number> | undefined;
	perTestCoverage?: Array<PerTestCoverageEntry> | undefined;
	result: JestResult;
	setupMs?: number | undefined;
	snapshotWrites?: SnapshotWrites | undefined;
}

export interface RawBackendEntry {
	entry: EnvelopeEntry;
	fallbackGameOutput?: string | undefined;
	/** Carried from the envelope; see {@link ProjectBackendResult}. */
	gameOutputScope?: "batch" | undefined;
}

export interface BackendResult {
	/**
	 * Workspace `--bail` runs only: indices into the `jobs` array of the
	 * packages a bailing task deliberately never reached. `rawResults` skips
	 * those, so it is parallel to `jobs` with these indices removed. Absent
	 * means every job ran.
	 */
	bailedJobIndices?: Array<number> | undefined;
	rawResults: Array<RawBackendEntry>;
	timing: BackendTiming;
}

export interface Backend {
	closeAsync?(): Promise<void> | void;
	readonly kind: BackendKind;
	runTestsAsync(options: BackendOptions): Promise<BackendResult>;
}

type BackendKind = "open-cloud" | "studio" | "studio-cli";

/**
 * Whether this is a workspace (multi-package) run. Workspace jobs each carry
 * their owning package name (`pkg`); single-/multi-project jobs never do, and
 * the run layer builds them all-or-none — so any job with `pkg` means the
 * whole run is a workspace run. The Studio backends key off this to drive the
 * plugin's staged-materializer dispatch (`workspace.entries`) instead of the
 * configs path. `buildWorkspaceEntries` then fails fast if a job is missing
 * `pkg`, so a malformed (mixed) array surfaces as a clear error rather than a
 * bad payload.
 */
export function isWorkspaceRun(jobs: ReadonlyArray<ProjectJob>): boolean {
	return jobs.some((job) => job.pkg !== undefined);
}

/**
 * A request to shard across multiple sessions: `"auto"` (the backend picks a
 * count) or an explicit count > 1.
 */
export function isShardedParallel(parallel: ParallelOption): parallel is "auto" | number {
	return parallel === "auto" || (typeof parallel === "number" && parallel > 1);
}

/**
 * A demand for more than one session, spelled out by hand. `"auto"` is not
 * one: it asks the backend for the count the run needs, and a backend driving
 * a single Studio instance needs 1 — so auto runs serially rather than
 * conflicting with it. This is the predicate every serial-backend guard reads.
 */
export function isExplicitMultiShard(parallel: ParallelOption): parallel is number {
	return typeof parallel === "number" && parallel > 1;
}
