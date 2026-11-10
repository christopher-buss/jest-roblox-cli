import { formatBytes } from "../terminal/bytes.ts";
import { plural } from "../terminal/plural.ts";
import type { FileSystem } from "../utils/file-system.ts";

/** The stages a run announces while it works. */
export type StageId = "boot" | "build" | "instrument" | "tests" | "upload";

/** Every stage, in run order. */
export const STAGE_IDS: ReadonlyArray<StageId> = ["instrument", "build", "upload", "boot", "tests"];

/** The stage where the block settles; must stay last in `STAGE_IDS`. */
export const LAST_STAGE: StageId = "tests";

export const STAGE_LABELS: Record<StageId, string> = {
	boot: "boot probe",
	build: "build place",
	instrument: "instrument",
	tests: "run tests",
	upload: "upload",
};

/**
 * What the `tests` stage says it is about to run, in every backend.
 * @param projectCount - Number of projects to run.
 * @returns The project count with its noun.
 */
export function describeProjectCount(projectCount: number): string {
	return `${projectCount.toString()} ${plural(projectCount, "project")}`;
}

/**
 * How big a place file is, for a stage detail.
 * @param placeFilePath - Place file to measure.
 * @param fileSystem - File system to stat it through.
 * @returns The formatted size, or `undefined` when the file cannot be read.
 */
export function describePlaceFile(
	placeFilePath: string,
	fileSystem: FileSystem,
): string | undefined {
	try {
		return formatBytes(fileSystem.statSync(placeFilePath).size);
	} catch {
		return undefined;
	}
}
