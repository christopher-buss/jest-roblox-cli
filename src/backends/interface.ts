import type { ResolvedConfig } from "../config/schema.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import type { JestResult } from "../types/jest-result.ts";

export interface BackendOptions {
	config: ResolvedConfig;
	testFiles: Array<string>;
}

export interface BackendTiming {
	executionMs: number;
	uploadCached?: boolean;
	uploadMs?: number;
}

export interface BackendResult {
	coverageData?: RawCoverageData;
	gameOutput?: string;
	luauTiming?: Record<string, number>;
	result: JestResult;
	snapshotWrites?: SnapshotWrites;
	timing: BackendTiming;
}

export interface Backend {
	runTests(options: BackendOptions): Promise<BackendResult>;
}
