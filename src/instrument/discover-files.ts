import picomatch from "picomatch";

import type { FileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { underRoot } from "../utils/normalize-windows-path.ts";
import { isLuauTestFile } from "../utils/test-file-kind.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";

const SNAPSHOT_SUFFIXES = [".snap.luau", ".snap.lua"] as const;

/** The `coverageCopyIgnorePatterns` gate, over root-relative paths. */
export type CopyIgnoreMatcher = (relativePath: string) => boolean;

/** One root's prod `.luau`/`.lua`, split by whether it earns probes. */
export interface RootFiles {
	/** Prod files outside the coverage universe, mirrored without probes. */
	excluded: Set<string>;
	/** Prod files the instrumenter will probe. */
	instrumentable: Set<string>;
}

/** How {@link discoverRootFiles} walks and splits a root. */
export interface DiscoverRootFilesOptions {
	/** Where the walk reads. Defaults to the real filesystem. */
	fileSystem: FileSystem;
	/** Paths the shadow never carries; absent means the whole root. */
	isCopyIgnored?: CopyIgnoreMatcher | undefined;
	/** Narrows which prod files probe; absent means all of them. */
	universe?: InstrumentUniverse | undefined;
}

/** What one walk collects, and what it refuses to descend into. */
export interface WalkFilter {
	/** Collect a file when true. Receives the entry's own name. */
	accept: (name: string) => boolean;
	/** Called with the relative path of each directory the walk enters. */
	onDirectory?: ((relativePath: string) => void) | undefined;
	/** Skip a relative path, with its subtree, when true. */
	skip?: CopyIgnoreMatcher | undefined;
}

/**
 * Compile `coverageCopyIgnorePatterns` into the gate every shadow pass shares.
 * @param patterns - Globs relative to the compiled root.
 * @returns Matcher that is true for an ignored path.
 */
export function createCopyIgnoreMatcher(patterns: ReadonlyArray<string>): CopyIgnoreMatcher {
	return picomatch([...patterns]);
}

/**
 * Stable digest of a copy-ignore list, for the incremental cache.
 * @param patterns - Copy-ignore globs.
 * @returns Hash of the sorted list.
 */
export function hashCopyIgnorePatterns(patterns: ReadonlyArray<string>): string {
	return hashString(JSON.stringify([...patterns].toSorted()));
}

/**
 * Prod `.luau` and `.lua` files, which earn probes.
 * @param name - File name or path.
 * @returns True for a Luau file that is not a spec, test or snapshot.
 */
export function isInstrumentableFile(name: string): boolean {
	return (name.endsWith(".luau") || name.endsWith(".lua")) && !isNonInstrumentedFile(name);
}

/**
 * Directories no pipeline walk descends into.
 * @param name - Directory entry name.
 * @returns True for `node_modules` and dot-prefixed names.
 */
export function isSkippedDirectory(name: string): boolean {
	return name === "node_modules" || name.startsWith(".");
}

/**
 * Shared directory walker over Luau files.
 * @param options - Directory, file system, filter, and the output array.
 */
export function walkLuauDirectory({
	directory,
	fileSystem,
	filter,
	results,
}: {
	directory: string;
	fileSystem: FileSystem;
	filter: WalkFilter;
	results: Array<string>;
}): void {
	walkFrom({ directory, fileSystem, filter, relativePrefix: "", results });
}

/**
 * Walk one root's prod .luau/.lua files, split by the coverage universe.
 * @param luauRoot - Root directory to walk.
 * @param options - The coverage universe and the copy-ignore gate.
 * @returns Discovered files split by instrumentability.
 */
export function discoverRootFiles(
	luauRoot: PosixRoot,
	{ fileSystem, isCopyIgnored, universe }: DiscoverRootFilesOptions,
): RootFiles {
	const discovered: Array<string> = [];
	walkLuauDirectory({
		directory: luauRoot,
		fileSystem,
		filter: { accept: isInstrumentableFile, skip: isCopyIgnored },
		results: discovered,
	});

	if (universe === undefined) {
		return { excluded: new Set(), instrumentable: new Set(discovered) };
	}

	const excluded = new Set<string>();
	const instrumentable = new Set<string>();
	for (const relativePath of discovered) {
		const isInUniverse = universe.includes(underRoot(luauRoot, relativePath));
		(isInUniverse ? instrumentable : excluded).add(relativePath);
	}

	return { excluded, instrumentable };
}

function isNonInstrumentedFile(filename: string): boolean {
	return (
		isLuauTestFile(filename) || SNAPSHOT_SUFFIXES.some((suffix) => filename.endsWith(suffix))
	);
}

function walkFrom({
	directory,
	relativePrefix,
	...walk
}: {
	directory: string;
	fileSystem: FileSystem;
	filter: WalkFilter;
	relativePrefix: string;
	results: Array<string>;
}): void {
	const { fileSystem, filter, results } = walk;
	const entries = fileSystem.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const relative = relativePrefix + entry.name;
		if (filter.skip?.(relative) === true) {
			continue;
		}

		if (entry.isDirectory()) {
			if (isSkippedDirectory(entry.name)) {
				continue;
			}

			filter.onDirectory?.(relative);
			walkFrom({
				...walk,
				directory: `${directory}/${entry.name}`,
				relativePrefix: `${relative}/`,
			});
		} else if (filter.accept(entry.name)) {
			results.push(relative);
		}
	}
}
