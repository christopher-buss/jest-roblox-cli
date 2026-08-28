import * as fs from "node:fs";

/**
 * The stages a run announces while it works. Each one covers a stretch that
 * produces no output of its own, so the CLI never looks stalled between the
 * run header and the report.
 */
export type StageId = "boot" | "build" | "coverage" | "instrument" | "results" | "tests" | "upload";

/**
 * Every stage, listed so the label column can be sized from the longest of
 * them. The order is the one a run that hits all of them passes through, which
 * nothing depends on — the block orders itself by when a stage first opened.
 */
export const STAGE_IDS: ReadonlyArray<StageId> = [
	"instrument",
	"build",
	"upload",
	"boot",
	"tests",
	"results",
	"coverage",
];

export const STAGE_LABELS: Record<StageId, string> = {
	boot: "boot probe",
	build: "build place",
	coverage: "coverage",
	instrument: "instrument",
	results: "collect results",
	tests: "run tests",
	upload: "upload",
};

/**
 * Orchestration Timing span names that double as user-facing stages. The span
 * tree is the event source for every host-side stage, so a phase announces
 * itself by being named here rather than by a `progress` call beside its
 * `profile` — the two cannot then disagree about when a phase runs. A span
 * absent from this map still times itself and renders nothing.
 *
 * The remote stages (`upload`, `boot`, `tests`) are not here: they happen
 * inside a backend, which holds no collector, and reach the reporter through
 * `BackendOptions.progress` instead.
 */
export const SPAN_STAGES: Record<string, StageId> = {
	buildOpenCloudPlace: "build",
	prepareCoverage: "instrument",
	processResults: "results",
	rojoBuild: "build",
};

/**
 * How big a place is, for the `build` stage that just wrote it and the
 * `upload` stage about to send it — the same file, so the same number and one
 * function. Undefined when it cannot be read: the build and the upload each
 * fail on that file with their own message, and a stage detail must not be
 * the thing that reports it.
 */
export function describePlaceFile(placeFilePath: string): string | undefined {
	try {
		return formatBytes(fs.statSync(placeFilePath).size);
	} catch {
		return undefined;
	}
}

/** What the `tests` stage says it is about to run, in every backend. */
export function describeProjectCount(projectCount: number): string {
	return projectCount === 1 ? "1 project" : `${projectCount.toString()} projects`;
}

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * 1024;

/**
 * Byte counts as a run reports them: whole bytes under a kilobyte, one decimal
 * above it. The sizes here are place files and their uploads, where the digit
 * past the point separates "the place grew" from noise.
 *
 * The ladder stops at megabytes. Open Cloud caps a place well below a gigabyte,
 * so the next rung would be a unit no run can reach and a branch no test can
 * honestly reach either.
 */
function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KILOBYTE) {
		return `${bytes.toFixed(0)} B`;
	}

	if (bytes < BYTES_PER_MEGABYTE) {
		return `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
	}

	return `${(bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`;
}
