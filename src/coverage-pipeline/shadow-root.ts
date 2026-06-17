import * as fs from "node:fs";
import * as path from "node:path";

import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { instrumentRoot } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";

/**
 * Suffixes for files that are not instrumented for coverage but still need
 * syncing to the shadow directory. Matches parse-ast.luau:131-139.
 */
const NON_INSTRUMENTED_SUFFIXES = [
	".spec.luau",
	".test.luau",
	".spec.lua",
	".test.lua",
	".snap.luau",
	".snap.lua",
] as const;

export interface PrepareShadowRootOptions {
	luauRoot: string;
	previousManifest?: CoverageManifest;
	shadowDir: string;
	/** Orchestration profiler forwarded to `instrumentRoot`. */
	timing?: TimingCollector;
	useIncremental: boolean;
}

export interface ShadowRootResult {
	changed: boolean;
	files: Record<string, InstrumentedFileRecord>;
	luauRoot: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	shadowDir: string;
}

interface SyncResult {
	changed: boolean;
	files: Record<string, NonInstrumentedFileRecord>;
}

interface FullCacheOptions {
	luauRoot: string;
	previousManifest: CoverageManifest;
	shadowDirectory: string;
	skipFiles: Set<string>;
}

export function isNonInstrumentedFile(filename: string): boolean {
	return NON_INSTRUMENTED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

/**
 * Fast directory walk to discover instrumentable .luau/.lua files.
 * Must match parse-ast.luau's discoverFiles logic (same skip rules).
 */
export function discoverInstrumentableFiles(luauRoot: string): Set<string> {
	const posixRoot = normalizeWindowsPath(luauRoot);
	const results: Array<string> = [];
	walkLuauDirectory(posixRoot, posixRoot, isInstrumentableFile, results);
	return new Set(results);
}

/**
 * Populate a shadow dir from one luauRoot: bulk-copy every file (cold path),
 * run the instrumenter to overlay instrumented prod files, then sync the files
 * the instrumenter never emits (spec/test/snap plus non-luau rojo files) with
 * hash-tracked records so the shadow is a complete mirror that satisfies rojo +
 * testMatch.
 *
 * On a warm run (cache hit) only changed files are re-instrumented, and the
 * shadow is reconciled against source so files deleted upstream don't linger.
 */
export function prepareShadowRoot(options: PrepareShadowRootOptions): ShadowRootResult {
	const { luauRoot, previousManifest, shadowDir, useIncremental } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	let changed = false;

	if (!useIncremental) {
		fs.mkdirSync(shadowDir, { recursive: true });
		fs.cpSync(luauRoot, shadowDir, { recursive: true });
	}

	let skipFiles: Set<string> | undefined;

	if (useIncremental && previousManifest !== undefined) {
		const {
			allCached,
			changed: hasChanges,
			skipFiles: computed,
		} = computeIncrementalState(luauRoot, previousManifest);
		skipFiles = computed;
		changed = hasChanges;

		if (allCached) {
			return buildFullCacheResult({
				luauRoot,
				previousManifest,
				shadowDirectory: shadowDir,
				skipFiles,
			});
		}
	}

	const files = instrumentRoot({
		luauRoot,
		shadowDir,
		skipFiles,
		timing,
	});

	if (Object.keys(files).length > 0) {
		changed = true;
	}

	const allFiles: Record<string, InstrumentedFileRecord> = { ...files };

	if (useIncremental && previousManifest !== undefined && skipFiles !== undefined) {
		carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);
	}

	const syncResult = syncNonInstrumentedFiles(
		luauRoot,
		shadowDir,
		previousManifest?.nonInstrumentedFiles,
	);

	if (syncResult.changed) {
		changed = true;
	}

	if (useIncremental && reconcileShadowToSource(luauRoot, shadowDir)) {
		changed = true;
	}

	return {
		changed,
		files: allFiles,
		luauRoot,
		nonInstrumentedFiles: syncResult.files,
		shadowDir,
	};
}

const COV_MAP_SUFFIX = ".cov-map.json";

/**
 * Does the source file backing a shadow entry still exist? A `.cov-map.json`
 * sidecar has no direct twin — it is keyed to its base `.luau`/`.lua`.
 */
function sourceTwinExists(luauRoot: string, relativePath: string): boolean {
	if (relativePath.endsWith(COV_MAP_SUFFIX)) {
		const base = relativePath.slice(0, -COV_MAP_SUFFIX.length);
		return (
			fs.existsSync(path.resolve(luauRoot, `${base}.luau`)) ||
			fs.existsSync(path.resolve(luauRoot, `${base}.lua`))
		);
	}

	return fs.existsSync(path.resolve(luauRoot, relativePath));
}

/**
 * Shared directory walker. Skips node_modules and dot-prefixed directories —
 * matching parse-ast.luau:113-147.
 * `predicate` receives the entry name and returns true to collect the file.
 */
function walkLuauDirectory(
	directory: string,
	relativeTo: string,
	predicate: (name: string) => boolean,
	results: Array<string>,
): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = normalizeWindowsPath(path.join(directory, entry.name));
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") {
				continue;
			}

			if (entry.name.startsWith(".")) {
				continue;
			}

			walkLuauDirectory(fullPath, relativeTo, predicate, results);
		} else if (predicate(entry.name)) {
			const relative = fullPath.slice(relativeTo.length + 1);
			results.push(relative);
		}
	}
}

/**
 * Reconcile a warm shadow dir against its source root: unlink every shadow file
 * whose source no longer exists. This is the warm-run deletion mechanism across
 * every file category the pipeline manages — instrumented prod `.luau`,
 * spec/test/snap, and non-luau rojo files (`init.meta.json`, `*.model.json`, …)
 * alike. Diffing against source (rather than a recorded file set) means a file
 * category the sync never tracked still gets cleaned up, so a stale
 * `init.meta.json` can't survive into the rojo build and fail it. It walks with
 * the same scope as the rest of the pipeline (`walkLuauDirectory` skips
 * `node_modules`/dot-dirs); vendored content under those dirs is governed by
 * `rojoInputsHash` instead, which forces a cold rebuild when it changes.
 * `.cov-map.json` sidecars are instrumenter output with no 1:1 source twin;
 * they map back to their base `.luau`/`.lua`. Returns whether anything was
 * removed, so the caller forces a place rebuild.
 */
function reconcileShadowToSource(luauRoot: string, shadowDirectory: string): boolean {
	if (!fs.existsSync(shadowDirectory)) {
		return false;
	}

	const posixShadow = normalizeWindowsPath(shadowDirectory);
	const shadowFiles: Array<string> = [];
	walkLuauDirectory(posixShadow, posixShadow, () => true, shadowFiles);

	let deleted = false;
	for (const relativePath of shadowFiles) {
		if (sourceTwinExists(luauRoot, relativePath)) {
			continue;
		}

		try {
			fs.unlinkSync(path.resolve(shadowDirectory, relativePath));
			deleted = true;
		} catch {
			// Best-effort cleanup
		}
	}

	return deleted;
}

function isInstrumentableFile(name: string): boolean {
	return (name.endsWith(".luau") || name.endsWith(".lua")) && !isNonInstrumentedFile(name);
}

/**
 * Every file the shadow dir must carry verbatim because the instrumenter never
 * emits it: spec/test/snap `.luau` plus all non-luau rojo files
 * (`init.meta.json`, `*.model.json`, …). The complement of
 * `isInstrumentableFile` — prod `.luau` is excluded because `instrumentRoot`
 * writes its instrumented copy into the shadow. `.cov-map.json` sidecars are
 * instrumenter output, not source, so they are excluded too.
 */
function shouldSyncToShadow(name: string): boolean {
	return !isInstrumentableFile(name) && !name.endsWith(COV_MAP_SUFFIX);
}

function carryForwardRecords(
	luauRoot: string,
	previousManifest: CoverageManifest,
	allFiles: Record<string, InstrumentedFileRecord>,
	skipFiles: Set<string>,
): void {
	const posixRoot = normalizeWindowsPath(luauRoot);

	for (const relativePath of skipFiles) {
		const fileKey = `${posixRoot}/${relativePath}`;
		Object.assign(allFiles, { [fileKey]: previousManifest.files[fileKey] });
	}
}

function discoverShadowSyncFiles(
	directory: string,
	relativeTo: string,
	results: Array<string>,
): void {
	walkLuauDirectory(directory, relativeTo, shouldSyncToShadow, results);
}

function syncNonInstrumentedFiles(
	luauRoot: string,
	shadowDirectory: string,
	previousNonInstrumented: Record<string, NonInstrumentedFileRecord> | undefined,
): SyncResult {
	const posixRoot = normalizeWindowsPath(luauRoot);
	const discovered: Array<string> = [];
	discoverShadowSyncFiles(posixRoot, posixRoot, discovered);

	const files: Record<string, NonInstrumentedFileRecord> = {};
	let changed = false;

	for (const relativePath of discovered) {
		const sourcePath = `${posixRoot}/${relativePath}`;
		const shadowPath = `${shadowDirectory}/${relativePath}`;

		const sourceBuffer = fs.readFileSync(path.resolve(sourcePath));
		const currentHash = hashBuffer(sourceBuffer);

		const previousRecord = previousNonInstrumented?.[sourcePath];
		// Reuse the previous record only if both the source hash matches
		// AND the shadow file it points at still exists. A partial cleanup
		// could leave the record valid on paper while the file is gone.
		if (
			previousRecord?.sourceHash === currentHash &&
			fs.existsSync(previousRecord.shadowPath)
		) {
			files[sourcePath] = previousRecord;
			continue;
		}

		const outputDirectory = path.dirname(shadowPath);
		fs.mkdirSync(outputDirectory, { recursive: true });
		fs.copyFileSync(path.resolve(sourcePath), shadowPath);

		files[sourcePath] = { shadowPath, sourceHash: currentHash, sourcePath };
		changed = true;
	}

	return { changed, files };
}

function computeSkipFiles(luauRoot: string, previousManifest: CoverageManifest): Set<string> {
	const skipFiles = new Set<string>();
	const posixRoot = normalizeWindowsPath(luauRoot);

	for (const [fileKey, record] of Object.entries(previousManifest.files)) {
		if (!fileKey.startsWith(`${posixRoot}/`)) {
			continue;
		}

		const relativePath = fileKey.slice(posixRoot.length + 1);
		const sourcePath = path.resolve(record.originalLuauPath);

		if (!fs.existsSync(sourcePath)) {
			continue;
		}

		const currentHash = hashBuffer(fs.readFileSync(sourcePath));
		if (currentHash !== record.sourceHash) {
			continue;
		}

		// A matching source hash isn't enough: a partial cleanup or an
		// interrupted run can leave the manifest pointing at outputs that
		// no longer exist. Force re-instrumentation rather than carry a
		// record forward whose shadow files are gone.
		if (!fs.existsSync(record.instrumentedLuauPath) || !fs.existsSync(record.coverageMapPath)) {
			continue;
		}

		skipFiles.add(relativePath);
	}

	return skipFiles;
}

function countPreviousFilesForRoot(luauRoot: string, previousManifest: CoverageManifest): number {
	const posixRoot = normalizeWindowsPath(luauRoot);
	let count = 0;
	for (const fileKey of Object.keys(previousManifest.files)) {
		if (fileKey.startsWith(`${posixRoot}/`)) {
			count++;
		}
	}

	return count;
}

/**
 * Check if all files in this root are unchanged (full cache hit).
 *
 * `changed` means previous files were deleted or modified — it does NOT cover
 * new files appearing on disk. When `allCached` is false but `changed` is also
 * false, new files exist and the caller detects them when `instrumentRoot`
 * returns non-empty results.
 */
function computeIncrementalState(
	luauRoot: string,
	previousManifest: CoverageManifest,
): { allCached: boolean; changed: boolean; skipFiles: Set<string> } {
	const skipFiles = computeSkipFiles(luauRoot, previousManifest);
	const previousCount = countPreviousFilesForRoot(luauRoot, previousManifest);
	const changed = skipFiles.size !== previousCount;

	if (changed) {
		return { allCached: false, changed, skipFiles };
	}

	// All previous files match. Check if any new files appeared on disk.
	const discovered = discoverInstrumentableFiles(luauRoot);
	const allCached = discovered.size === previousCount;

	return { allCached, changed, skipFiles };
}

function buildFullCacheResult(options: FullCacheOptions): ShadowRootResult {
	const { luauRoot, previousManifest, shadowDirectory, skipFiles } = options;

	const allFiles: Record<string, InstrumentedFileRecord> = {};
	carryForwardRecords(luauRoot, previousManifest, allFiles, skipFiles);

	const syncResult = syncNonInstrumentedFiles(
		luauRoot,
		shadowDirectory,
		previousManifest.nonInstrumentedFiles,
	);
	// Call reconcile unconditionally (not inside the `||`) so its cleanup side
	// effect always runs even when the sync already flagged a change.
	const reconciled = reconcileShadowToSource(luauRoot, shadowDirectory);

	return {
		changed: syncResult.changed || reconciled,
		files: allFiles,
		luauRoot,
		nonInstrumentedFiles: syncResult.files,
		shadowDir: shadowDirectory,
	};
}
