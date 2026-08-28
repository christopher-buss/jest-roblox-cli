import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { luauParser } from "../luau/parser.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { CollectorResult } from "./coverage-collector.ts";
import { collectCoverage } from "./coverage-collector.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";
import { writeCoverageMap } from "./coverage-map.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { discoverRootFiles } from "./discover-files.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./manifest.ts";
import { MANIFEST_VERSION, writeManifest } from "./manifest.ts";
import { insertProbes } from "./probe-inserter.ts";

export const INSTRUMENTER_VERSION = 5;

const LUAU_EXTENSION = /\.luau?$/;

export interface InstrumentRootOptions {
	/**
	 * Paths the shadow never carries, relative to `luauRoot`. Asked here as
	 * well as at the copy so an ignored module is never probed into existence
	 * behind the copy's back — the standalone `instrument` subcommand, which
	 * builds no shadow to keep in step, leaves it out.
	 */
	isCopyIgnored?: CopyIgnoreMatcher | undefined;
	luauRoot: string;
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

export interface InstrumentOptions extends InstrumentRootOptions {
	manifestPath: string;
}

/** Everything the per-file instrumentation pass captures from its root. */
interface InstrumentFileContext {
	/**
	 * Shadow directories this pass has already made, so only the first file in
	 * a directory pays the `mkdirSync`. Scoped to one `instrumentRoot` call —
	 * one `shadowDir` — so it cannot outlive the tree it describes.
	 */
	createdDirectories: Set<string>;
	/** POSIX-normalized luauRoot — the first half of every file key. */
	posixLuauRoot: string;
	shadowDir: string;
	timing: TimingCollector;
}

/**
 * Instrument a single luauRoot directory. Returns the files map without
 * writing a manifest — used by `prepareCoverage()` to merge multiple roots.
 */
export function instrumentRoot(options: InstrumentRootOptions): CoverageManifest["files"] {
	const { isCopyIgnored, luauRoot, shadowDir, skipFiles } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	const fileList = timing.profile("discover-files", () => {
		return [...discoverRootFiles(luauRoot, { isCopyIgnored }).instrumentable];
	});

	const files: CoverageManifest["files"] = {};
	const context: InstrumentFileContext = {
		createdDirectories: new Set<string>(),
		posixLuauRoot: toPosixRoot(luauRoot),
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

/**
 * Instrument a single luauRoot and write a standalone manifest.
 * Used by the `instrument` subcommand.
 */
export function instrument(options: InstrumentOptions): CoverageManifest {
	const { luauRoot, manifestPath, shadowDir } = options;

	const files = instrumentRoot(options);
	const posixLuauRoot = toPosixRoot(luauRoot);

	const generatedAtDate = new Date();
	const manifest: CoverageManifest = {
		buildId: crypto.randomUUID(),
		files,
		generatedAt: generatedAtDate.toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: [posixLuauRoot],
		nonInstrumentedFiles: {},
		shadowDir: normalizeWindowsPath(shadowDir),
		version: MANIFEST_VERSION,
	};

	writeManifest(manifestPath, manifest);

	return manifest;
}

/** Parse one file and collect its coverage sites, or fail naming the file. */
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

	return timing.profile("collect-coverage", () => collectCoverage(parsed.root, source));
}

/**
 * `mkdirSync` the directory unless this pass already made it. `recursive: true`
 * stays on: the cache elides repeats only, so the first file at any depth must
 * still be able to create the whole chain above it.
 */
function ensureDirectory(directory: string, createdDirectories: Set<string>): void {
	if (createdDirectories.has(directory)) {
		return;
	}

	fs.mkdirSync(directory, { recursive: true });
	createdDirectories.add(directory);
}

/**
 * Instrument one discovered file: write its instrumented twin and `.cov-map`
 * sidecar into the shadow dir, and return the manifest record for it.
 */
function instrumentFile(
	relativePath: string,
	{ createdDirectories, posixLuauRoot, shadowDir, timing }: InstrumentFileContext,
): InstrumentedFileRecord {
	// The cross-machine join key: the same string is written to the manifest
	// record below and baked into the instrumented preamble by `insertProbes`,
	// so the runtime hit map lines up with the static maps byte-for-byte.
	const fileKey = normalizeWindowsPath(path.join(posixLuauRoot, relativePath));
	const shadowFilePath = path.join(shadowDir, relativePath);
	// LUAU_EXTENSION is end-anchored, so swapping the suffix on the joined path
	// is the same as joining the swapped relative path.
	const coverageMapOutputPath = shadowFilePath.replace(LUAU_EXTENSION, ".cov-map.json");

	const sourceBuffer = timing.profile("read-source", () => {
		return fs.readFileSync(path.resolve(fileKey));
	});
	const source = sourceBuffer.toString("utf-8");
	const collectorResult = collectFileCoverage({ relativePath, source, timing });
	const instrumentedSource = timing.profile("probe-insert", () => {
		return insertProbes(source, collectorResult, fileKey);
	});
	const coverageMap = timing.profile("map-build", () => buildCoverageMap(collectorResult));

	timing.profile("write-shadow", () => {
		// Not `atomicWrite` like the package's other publishers: on Windows the
		// rename it adds per covered file roughly triples the cost of the write
		// it protects. The atomic cov-map below covers the kill window that
		// leaves. Re-measure the `write-shadow` span under `TIMING` first.
		ensureDirectory(path.dirname(shadowFilePath), createdDirectories);
		fs.writeFileSync(shadowFilePath, instrumentedSource);
		// Same directory as the twin, already made above — but `atomicWrite`
		// under here remakes it per file. Deduping that too would mean an
		// opt-out on a helper six publishers share, for microseconds.
		writeCoverageMap(coverageMapOutputPath, coverageMap);
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
