import * as path from "node:path";

import { writeCoverageMap } from "../coverage-data/coverage-map.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "../coverage-data/manifest.ts";
import { luauParser } from "../luau/parser.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, underRoot } from "../utils/normalize-windows-path.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";
import { collectCoverage } from "./coverage-collector.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { discoverRootFiles } from "./discover-files.ts";
import { insertProbes } from "./probe-inserter.ts";
import { clearDirectoryAtFilePath, createShadowDirectory } from "./shadow-entry.ts";

export const INSTRUMENTER_VERSION = 6;

const LUAU_EXTENSION = /\.luau?$/;

/** Instruments one root and returns its file records. */
export type Instrumenter = typeof instrumentRoot;

interface InstrumentRootOptions {
	fileSystem: FileSystem;
	/**
	 * Must match the shadow copy's gate, else an ignored module gets probed.
	 */
	isCopyIgnored?: CopyIgnoreMatcher | undefined;
	luauRoot: PosixRoot;
	shadowDir: string;
	skipFiles?: Set<string> | undefined;
	timing?: TimingCollector | undefined;
}

interface ShadowPathContext {
	/**
	 * Scoped to one `instrumentRoot` call: it must not outlive its
	 * `shadowDir`.
	 */
	createdDirectories: Set<string>;
	shadowDir: string;
}

interface InstrumentFileContext extends ShadowPathContext {
	fileSystem: FileSystem;
	luauRoot: PosixRoot;
	timing: TimingCollector;
}

interface TwinOutput {
	coverageMap: ReturnType<typeof buildCoverageMap>;
	coverageMapOutputPath: string;
	instrumentedSource: string;
	shadowFilePath: string;
}

function instrumentRoot(options: InstrumentRootOptions): CoverageManifest["files"] {
	const { fileSystem, isCopyIgnored, luauRoot, shadowDir, skipFiles } = options;
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
 * `prepareShadowRoot` instruments before it mirrors, so no level is judged
 * yet.
 *
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
	prepareTwinPath({ createdDirectories, fileSystem, relativePath, shadowDir, shadowFilePath });
	fileSystem.writeFileSync(shadowFilePath, instrumentedSource);
	writeCoverageMap({ filePath: coverageMapOutputPath, fileSystem, map: coverageMap });
}

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

function instrumentFile(
	relativePath: string,
	{ createdDirectories, fileSystem, luauRoot, shadowDir, timing }: InstrumentFileContext,
): InstrumentedFileRecord {
	// Join key: `insertProbes` bakes this same string into the preamble.
	const fileKey = underRoot(luauRoot, relativePath);
	const shadowFilePath = path.join(shadowDir, relativePath);
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
		// Valid only while `insertProbes` keeps the twin line-aligned.
		sourceMapPath: `${fileKey}.map`,
		statementCount: collectorResult.statements.length,
	};
}
