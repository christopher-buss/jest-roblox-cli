import type { SourceMapper } from "../source-mapper/index.ts";
import type { BailSummary } from "../types/bail-summary-types.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import {
	dropDriveLetter,
	normalizeWindowsPath,
	relativeToRoot,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";

/** What {@link resolveDisplayPath} shows a test file path through. */
export interface DisplayPathOptions {
	/** Root a path under it is shown relative to. */
	rootDir: string;
	/** Maps a test file to its source path. */
	sourceMapper?: SourceMapper | undefined;
}

/**
 * What a Partial Run selected its tests for: the files changed since a ref,
 * or the related source files, relative to the run root.
 */
export type PartialRunCause =
	| { files: ReadonlyArray<string>; kind: "related" }
	| { kind: "changed"; since: string };

/**
 * How many test files a Partial Run selected, and what it selected them for.
 */
export interface AffectedSummary {
	/** Test files the run selected. */
	affected: number;
	/** What the selection is for. */
	cause: PartialRunCause;
	/** Test files a full run would have run. */
	total: number;
}

/**
 * Options every formatter reads.
 */
export interface FormatOptions {
	/**
	 * Partial Run only: how many test files it selected out of the total.
	 */
	affected?: AffectedSummary | undefined;
	/**
	 * Workspace `--bail` only: how far the run got before a failing package
	 * stopped it. Absent on a run that reached every package.
	 */
	bail?: BailSummary | undefined;
	/**
	 * Announce coverage collection in the header.
	 */
	collectCoverage?: boolean | undefined;
	/**
	 * Emit ANSI color.
	 */
	color: boolean;
	/**
	 * Omit files with no failing test and no execution error.
	 */
	failuresOnly?: boolean | undefined;
	/**
	 * Path of the written Roblox game log, named in the footer.
	 */
	gameOutput?: string | undefined;
	/**
	 * Path of the written full Jest output, named in the footer.
	 */
	outputFile?: string | undefined;
	/**
	 * Directory that displayed paths are relative to.
	 */
	rootDir: string;
	/**
	 * Show the Luau source beside mapped TypeScript in failure snippets.
	 */
	showLuau?: boolean | undefined;
	/**
	 * Milliseconds above which a duration is styled as slow.
	 */
	slowTestThreshold?: number | undefined;
	/**
	 * Snapshots that failed to write, reported in the summary.
	 */
	snapshotWriteFailures?: number | undefined;
	/**
	 * Maps Luau paths and locations back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Type errors found, reported in the summary.
	 */
	typeErrors?: number | undefined;
	/**
	 * List each passing test under its file.
	 */
	verbose: boolean;
	/**
	 * CLI version shown in the header.
	 */
	version: string;
}

/**
 * One project's result in a multi-project render.
 */
export interface FormatterProjectEntry {
	/**
	 * Color of the project badge.
	 */
	displayColor?: string | undefined;
	/**
	 * Label of the project badge.
	 */
	displayName: string;
	/**
	 * The project's raw Game Output, shown when it fails.
	 */
	gameOutput?: string | undefined;
	/**
	 * The project's Jest result.
	 */
	result: JestResult;
	/**
	 * Package root the project's failure detail is shown relative to.
	 */
	rootDir?: string | undefined;
}

/**
 * Running numbering for the detailed-failure blocks, shared across projects.
 */
export interface FailureContext {
	/**
	 * Number of the last rendered failure block.
	 */
	currentIndex: number;
	/**
	 * Failure blocks across all projects.
	 */
	totalFailures: number;
}

/**
 * Show a path relative to a root it lies under.
 * @param filePath - Path to shorten.
 * @param rootDirectory - Root to shorten against.
 * @returns The relative POSIX path, or `filePath` when outside the root.
 */
export function makeRelative(filePath: string, rootDirectory: string): string {
	const root = toPosixRoot(dropDriveLetter(normalizeWindowsPath(rootDirectory)));

	return relativeToRoot(root, dropDriveLetter(normalizeWindowsPath(filePath))) ?? filePath;
}

/**
 * Resolve the source path a test file is shown by.
 * @param testFilePath - Path Jest reported for the test file.
 * @param options - The run's root and the mapper to its source path.
 * @returns The path to show.
 */
export function resolveDisplayPath(
	testFilePath: string,
	{ rootDir, sourceMapper }: DisplayPathOptions,
): string {
	return makeRelative(sourceMapper?.resolveDisplayPath(testFilePath) ?? testFilePath, rootDir);
}

/**
 * Point failure detail at a project's package root.
 * @template T - The options shape.
 * @param options - The run's options.
 * @param packageRoot - The project's package root; the run root when absent.
 * @returns The options for the project's failure detail.
 */
export function withPackageRoot<T extends { rootDir: string }>(
	options: T,
	packageRoot: string | undefined,
): T {
	return packageRoot === undefined ? options : { ...options, rootDir: packageRoot };
}
