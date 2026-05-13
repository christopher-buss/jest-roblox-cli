import type { ResolvedConfig } from "../config/schema.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import type {
	StreamingResultEntry,
	StreamingResultReader,
} from "../memory-store/sorted-map-client.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import type { JestResult } from "../types/jest-result.ts";

export interface ProjectJob {
	config: ResolvedConfig;
	displayColor?: string;
	displayName: string;
	/**
	 * Workspace-mode only: the npm package name (e.g. `@halcyon/foo`) that
	 * owns this project. Combined with `displayName` it forms the lookup key
	 * used by work-stealing to match Luau-emitted entries to jobs. Outside
	 * workspace mode this is undefined and the lookup falls back to
	 * `displayName` alone.
	 */
	pkg?: string;
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
	pollMs?: number;
	reader: StreamingResultReader;
}

export interface BackendOptions {
	jobs: Array<ProjectJob>;
	/**
	 * Open-Cloud-only: number of concurrent Open Cloud Luau execution sessions
	 * to fire. Unset or 1 means one session carrying all jobs. `"auto"` resolves
	 * to min(jobs.length, 3). Studio backend must error when this is set to
	 * anything other than undefined/1 (Phase 4 enforces at the CLI layer).
	 */
	parallel?: "auto" | number;
	/**
	 * Workspace mode: pre-built Luau script that the backend should send
	 * verbatim instead of generating one from `jobs`. Used by the staged
	 * materializer pipeline so the CLI layer chooses the script and the
	 * backend stays unaware of the difference.
	 */
	scriptOverride?: string;
	/**
	 * Open-Cloud-only, work-stealing only: when provided, the backend polls
	 * the SortedMap concurrently with executeScript and invokes
	 * `onPackageResult` per newly-observed entry. Consumed entries are
	 * deleted to avoid re-emission. Streaming is best-effort: failure to
	 * poll/delete does not affect the final results returned in the task
	 * envelope.
	 */
	streaming?: StreamingHooks;
	/**
	 * Open-Cloud-only: when true, fire `parallel` tasks all running the SAME
	 * `scriptOverride` (no static job-bucket split). Each task pulls work from
	 * a MemoryStore queue (set up upstream) and returns whatever subset of
	 * packages it processed. Backend aggregates entries across all task
	 * envelopes and maps each to the matching `ProjectJob.displayName` by the
	 * entry's `pkg` field. `scriptOverride` is required when this is true.
	 */
	workStealing?: boolean;
}

export interface BackendTiming {
	executionMs: number;
	uploadCached?: boolean;
	uploadMs?: number;
}

export interface ProjectBackendResult {
	coverageData?: RawCoverageData;
	displayColor?: string;
	displayName: string;
	elapsedMs: number;
	gameOutput?: string;
	luauTiming?: Record<string, number>;
	result: JestResult;
	setupMs?: number;
	snapshotWrites?: SnapshotWrites;
}

export interface BackendResult {
	results: Array<ProjectBackendResult>;
	timing: BackendTiming;
}

export interface Backend {
	close?(): Promise<void> | void;
	readonly kind: BackendKind;
	runTests(options: BackendOptions): Promise<BackendResult>;
}

type BackendKind = "open-cloud" | "studio";
