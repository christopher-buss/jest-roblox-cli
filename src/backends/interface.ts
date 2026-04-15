import type { ResolvedConfig } from "../config/schema.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import type { JestResult } from "../types/jest-result.ts";

export interface ProjectJob {
	config: ResolvedConfig;
	displayColor?: string;
	displayName: string;
	testFiles: Array<string>;
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

export type BackendKind = "open-cloud" | "studio";

export interface Backend {
	close?(): Promise<void> | void;
	readonly kind: BackendKind;
	runTests(options: BackendOptions): Promise<BackendResult>;
}
