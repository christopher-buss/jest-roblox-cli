import * as path from "node:path";

import { luauParser } from "../luau/parser.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, underRoot } from "../utils/normalize-windows-path.ts";
import type { CollectorResult } from "./coverage-collector.ts";
import { collectCoverage } from "./coverage-collector.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";
import { writeCoverageMap } from "./coverage-map.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { discoverRootFiles } from "./discover-files.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./manifest.ts";
import { insertProbes } from "./probe-inserter.ts";
import { clearDirectoryAtFilePath, createShadowDirectory } from "./shadow-entry.ts";

export const INSTRUMENTER_VERSION = 6;

const LUAU_EXTENSION = /\.luau?$/;

/**
 * Instruments one root and returns its file records.
 */
export type Instrumenter = typeof instrumentRoot;

/**
 * Inputs for instrumenting one root into its shadow.
 */
interface InstrumentRootOptions {
	/**
	 * Where the twins are read and written. Defaults to the real filesystem.
	 */
	fileSystem?: FileSystem;
	/**
	 * Paths the shadow never carries, relative to `luauRoot`. Asked here as
	 * well as at the copy so an ignored module is never probed into existence
	 * behind the copy's back — the standalone `instrument` subcommand, which
	 * builds no shadow to keep in step, leaves it out.
	 */
	isCopyIgnored?: CopyIgnoreMatcher | undefined;
	/**
	 * Source root whose prod Luau files are instrumented.
	 */
	luauRoot: PosixRoot;
	/**
	 * Directory the twins and their `.cov-map.json` sidecars are written to.
	 */
	shadowDir: string;
	/**
	 * Relative paths the instrumenter must not parse — unchanged files whose
	 * records the caller carries forward, plus files outside the coverage
	 * universe. Both reach the same skip list because a file never parsed is a
	 * file never paid for, and parsing dominates this pass. Telling them apart
	 * is the caller's job: only the first kind has a record worth keeping.
	 */
	skipFiles?: Set<string> | undefined;
	/**
	 * Orchestration profiler. Every step of the per-file pass gets a span, not
	 * just the interesting ones: the enclosing phase reports what its children
	 * left unaccounted for, so a step left unnamed here shows up only as an
	 * `(unmeasured)` remainder with nothing to point at.
	 */
	timing?: TimingCollector | undefined;
}

/** Where a twin's path is rooted, and which levels of it are already judged. */
interface ShadowPathContext {
	/**
	 * Shadow directories this pass has already judged, so only the first file
	 * under one pays for it. Scoped to one `instrumentRoot` call — one
	 * `shadowDir` — so it cannot outlive the tree it describes.
	 */
	createdDirectories: Set<string>;
	shadowDir: string;
}

/** Everything the per-file instrumentation pass captures from its root. */
interface InstrumentFileContext extends ShadowPathContext {
	fileSystem: FileSystem;
	/** The first half of every file key. */
	luauRoot: PosixRoot;
	timing: TimingCollector;
}

/** What one instrumented file leaves in the shadow: the twin and its map. */
interface TwinOutput {
	coverageMap: ReturnType<typeof buildCoverageMap>;
	coverageMapOutputPath: string;
	instrumentedSource: string;
	shadowFilePath: string;
}

/**
 * Instrument a single luauRoot directory. Returns the files map without
 * writing a manifest — used by `prepareCoverage()` to merge multiple roots.
 * @param options - Root, shadow directory, skip list and collaborators.
 * @returns Records for every instrumented file, keyed by file key.
 * @throws When a file fails to parse.
 */
function instrumentRoot(options: InstrumentRootOptions): CoverageManifest["files"] {
	const { fileSystem = nodeFileSystem, isCopyIgnored, luauRoot, shadowDir, skipFiles } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	const fileList = timing.profile("discover-files", () => {
		return [...discoverRootFiles(luauRoot, { fileSystem, isCopyIgnored }).instrumentable];
	});

	const files: CoverageManifest["files"] = {};
	const context: InstrumentFileContext = {
		createdDirectories: new Set<string>(),
		fileSystem,
		luauRoot,
		shadowDir,
		timing,
	};

	for (const relativePath of fileList) {
		if (skipFiles?.has(relativePath) === true) {
			continue;
		}

		const record = instrumentFile(relativePath, context);
		files[record.key] = record;
	}

	return files;
}

export const nodeInstrumenter: Instrumenter = instrumentRoot;

/**
 * `createShadowDirectory` one shadow directory unless this pass already judged
 * it. The cache holds every level it is given, so each directory costs one
 * `stat` per run rather than one per file written under it.
 * @param options - The directory, the pass's cache and the file system.
 */
function ensureShadowDirectory({
	createdDirectories,
	directory,
	fileSystem,
}: {
	createdDirectories: Set<string>;
	directory: string;
	fileSystem: FileSystem;
}): void {
	if (createdDirectories.has(directory)) {
		return;
	}

	createShadowDirectory(directory, fileSystem);
	createdDirectories.add(directory);
}

/**
 * Ready the path one instrumented twin is written to.
 *
 * The chain is walked a level at a time rather than made by one recursive
 * `mkdirSync`, because a stale file on any level blocks the whole make and the
 * recursive call cannot be trusted to say so. The instrumenter is the pass that
 * has to survive that: `prepareShadowRoot` instruments before it mirrors, so
 * the mirror walk — which judges the same levels against source — has not run.
 *
 * The twin's own path is cleared last, and never cached: that clash is per
 * file, so it costs a `stat` on every file written. Cheap against the write and
 * the atomic cov-map that follow, but not free — measure before adding another.
 *
 * The `.cov-map.json` sidecar beside the twin is deliberately not cleared. Only
 * a source directory named `*.cov-map.json` can put a directory on that path,
 * and on a tree holding one the mirror walk deletes the sidecar to make its own
 * twin every run regardless: both writers want the path, and clearing here
 * would trade a loud failure for a shadow that thrashes silently.
 * @param options - Shadow directory, cache, relative and twin paths, and file
 * system.
 */
function prepareTwinPath({
	createdDirectories,
	fileSystem,
	relativePath,
	shadowDir,
	shadowFilePath,
}: ShadowPathContext & {
	fileSystem: FileSystem;
	relativePath: string;
	shadowFilePath: string;
}): void {
	let directory = shadowDir;
	ensureShadowDirectory({ createdDirectories, directory, fileSystem });

	const parent = path.dirname(relativePath);
	if (parent !== ".") {
		// The discovery walk keys every path with "/", whatever the platform.
		for (const segment of parent.split("/")) {
			directory = path.join(directory, segment);
			ensureShadowDirectory({ createdDirectories, directory, fileSystem });
		}
	}

	clearDirectoryAtFilePath(shadowFilePath, fileSystem);
}

function publishTwin(
	{ coverageMap, coverageMapOutputPath, instrumentedSource, shadowFilePath }: TwinOutput,
	{
		createdDirectories,
		fileSystem,
		relativePath,
		shadowDir,
	}: Pick<InstrumentFileContext, "createdDirectories" | "fileSystem" | "shadowDir"> & {
		relativePath: string;
	},
): void {
	// Not `atomicWrite` like the package's other publishers: on Windows the
	// rename it adds per covered file roughly triples the cost of the write it
	// protects. The atomic cov-map below covers the kill window that leaves.
	// Re-measure the `write-shadow` span under `TIMING` first.
	prepareTwinPath({ createdDirectories, fileSystem, relativePath, shadowDir, shadowFilePath });
	fileSystem.writeFileSync(shadowFilePath, instrumentedSource);
	// Same directory as the twin, already made above — but `atomicWrite` under
	// here remakes it per file. Deduping that too would mean a second opt-out on
	// a helper the package's publishers share, for microseconds; the one
	// `writeCoverageMap` already takes buys more than that.
	writeCoverageMap({ filePath: coverageMapOutputPath, fileSystem, map: coverageMap });
}

/**
 * Parse one file and collect its coverage sites, or fail naming the file.
 * @param options - Source text, its relative path and the profiler.
 * @returns The collected coverage sites.
 * @throws When the source fails to parse.
 */
function collectFileCoverage({
	relativePath,
	source,
	timing,
}: {
	relativePath: string;
	source: string;
	timing: TimingCollector;
}): CollectorResult {
	const parsed = timing.profile("parse-ast", () => luauParser.parse(source));
	if (!parsed.ok) {
		throw new Error(`Failed to parse ${relativePath}: ${parsed.errors.join("; ")}`);
	}

	return timing.profile("collect-coverage", () => collectCoverage(parsed, source));
}

/**
 * The probes one file declares, and the twin those probes were inserted into.
 * @param sourceBuffer - Raw source bytes, read as UTF-8.
 * @param options - File key, relative path and profiler.
 * @returns Coverage sites plus the instrumented source.
 * @throws When the source fails to parse.
 */
function buildCollectorResult(
	sourceBuffer: ReturnType<FileSystem["readFileSync"]>,
	{
		fileKey,
		relativePath,
		timing,
	}: { fileKey: string; relativePath: string; timing: TimingCollector },
): ReturnType<typeof collectFileCoverage> & { instrumentedSource: string } {
	const source = sourceBuffer.toString("utf-8");
	const collectorResult = collectFileCoverage({ relativePath, source, timing });
	return {
		...collectorResult,
		instrumentedSource: timing.profile("probe-insert", () => {
			return insertProbes({ fileKey, result: collectorResult, source });
		}),
	};
}

/**
 * Instrument one discovered file: write its instrumented twin and `.cov-map`
 * sidecar into the shadow dir, and return the manifest record for it.
 * @param relativePath - Root-relative path of the file.
 * @param context - Root, shadow directory, cache, file system and profiler.
 * @returns The file's manifest record.
 * @throws When the source fails to parse.
 */
function instrumentFile(
	relativePath: string,
	{ createdDirectories, fileSystem, luauRoot, shadowDir, timing }: InstrumentFileContext,
): InstrumentedFileRecord {
	// The cross-machine join key: the same string is written to the manifest
	// record below and baked into the instrumented preamble by `insertProbes`,
	// so the runtime hit map lines up with the static maps byte-for-byte.
	const fileKey = underRoot(luauRoot, relativePath);
	const shadowFilePath = path.join(shadowDir, relativePath);
	// LUAU_EXTENSION is end-anchored, so swapping the suffix on the joined path
	// is the same as joining the swapped relative path.
	const coverageMapOutputPath = shadowFilePath.replace(LUAU_EXTENSION, ".cov-map.json");

	const sourceBuffer = timing.profile("read-source", () => {
		return fileSystem.readFileSync(path.resolve(fileKey));
	});
	const collectorResult = buildCollectorResult(sourceBuffer, { fileKey, relativePath, timing });
	const twin = {
		coverageMap: timing.profile("map-build", () => buildCoverageMap(collectorResult)),
		coverageMapOutputPath,
		instrumentedSource: collectorResult.instrumentedSource,
		shadowFilePath,
	};

	timing.profile("write-shadow", () => {
		publishTwin(twin, { createdDirectories, fileSystem, relativePath, shadowDir });
	});

	return {
		key: fileKey,
		branchCount: collectorResult.branches.length,
		coverageMapPath: normalizeWindowsPath(coverageMapOutputPath),
		functionCount: collectorResult.functions.length,
		instrumentedLuauPath: normalizeWindowsPath(shadowFilePath),
		originalLuauPath: fileKey,
		sourceHash: hashBuffer(sourceBuffer),
		// The original's map, not one beside the twin in the shadow. Legal
		// because `insertProbes` keeps the twin line-for-line aligned with the
		// original, so one map describes both without a line shift.
		sourceMapPath: `${fileKey}.map`,
		statementCount: collectorResult.statements.length,
	};
}
