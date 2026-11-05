import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { readCoverageMap } from "./coverage-map.ts";
import type { RawCoverageData } from "./coverage-types.ts";
import type { CoverageManifest } from "./manifest.ts";
import { passthroughFile } from "./mapper-passthrough.ts";
import { buildMappedResult, createPendingCoverage } from "./mapper-pending.ts";
import { mapSourceMappedFile } from "./mapper-source-mapped.ts";
import type { FileResources, MappedCoverageResult, PositionResolver } from "./mapper-types.ts";

/**
 * Inputs to {@link mapCoverageToTypeScript}.
 */
export interface CoverageMappingOptions {
	/** Runtime hit counts keyed by manifest file key. */
	coverageData: RawCoverageData;
	/** Filesystem the maps are read from. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** Coverage Manifest naming every instrumented file. */
	manifest: CoverageManifest;
	/** Builds a position resolver from raw source map JSON. */
	traceMapFactory?: TraceMapFactory;
}

/**
 * Signature of {@link mapCoverageToTypeScript}, for injection.
 */
export type CoverageMapper = typeof mapCoverageToTypeScript;

// No real source map can express a span whose end resolves to nothing:
// trace-mapping snaps a column at or after a segment onto that segment.
type TraceMapFactory = (rawSourceMap: string) => PositionResolver;

/**
 * Thrown when a coverage map sidecar is present on disk but cannot be parsed or
 * validated. Silently skipping these files would let coverage thresholds pass
 * on incomplete data — the exact silent-breakage failure mode this guard is
 * meant to eliminate.
 */
class CoverageMapMalformedError extends Error {
	public readonly coverageMapPath: string;

	/**
	 * Name the malformed sidecar in the message.
	 * @param coverageMapPath - Path of the unreadable coverage map.
	 */
	constructor(coverageMapPath: string) {
		super(
			`Coverage map at ${coverageMapPath} is malformed or invalid (re-run \`jest-roblox instrument\`)`,
		);
		this.coverageMapPath = coverageMapPath;
	}
}

/**
 * Map runtime Luau hits onto the original sources through each file's coverage
 * map and source map, zero-filling files no test reached.
 * @param options - Hits, manifest, filesystem and source map factory.
 * @returns Istanbul file coverage keyed by original source path.
 * @throws {CoverageMapMalformedError} When a coverage map exists but is invalid.
 */
export function mapCoverageToTypeScript({
	coverageData,
	fileSystem = nodeFileSystem,
	manifest,
	traceMapFactory = traceMappingFactory,
}: CoverageMappingOptions): MappedCoverageResult {
	const pending = createPendingCoverage();

	// The manifest is the report universe: every instrumented file is reported,
	// using runtime hits where a test exercised the file and zero-filling where
	// none did. Keying off the runtime hit map instead would silently omit
	// untested files, letting them slip past `coverageThreshold`.
	for (const [fileKey, record] of Object.entries(manifest.files)) {
		const fileCoverage = coverageData[fileKey] ?? { s: {} };

		const resources = loadFileResources({ fileSystem, record, traceMapFactory });
		if (resources === undefined) {
			continue;
		}

		if (resources.resolvePosition === undefined) {
			passthroughFile({ fileCoverage, pending, resources });
		} else {
			mapSourceMappedFile({
				fileCoverage,
				pending,
				resources: {
					coverageMap: resources.coverageMap,
					resolvePosition: resources.resolvePosition,
					sourceMapDirectory: resources.sourceMapDirectory,
				},
			});
		}
	}

	return buildMappedResult(pending);
}

function traceMappingFactory(rawSourceMap: string): PositionResolver {
	const traceMap = new TraceMap(rawSourceMap);
	return (position) => originalPositionFor(traceMap, position);
}

function loadFileResources({
	fileSystem,
	record,
	traceMapFactory,
}: {
	fileSystem: FileSystem;
	record: CoverageManifest["files"][string];
	traceMapFactory: TraceMapFactory;
}): FileResources | undefined {
	const result = readCoverageMap(record.coverageMapPath, fileSystem);
	// File missing → silent skip (stale cache, will be regenerated).
	// File present-but-unreadable → throw, so callers don't compute reports
	// or enforce thresholds on incomplete data.
	if (result.kind === "missing") {
		return undefined;
	}

	if (result.kind === "invalid") {
		throw new CoverageMapMalformedError(record.coverageMapPath);
	}

	let resolvePosition: PositionResolver | undefined;
	try {
		const sourceMapRaw = fileSystem.readFileSync(record.sourceMapPath, "utf-8");
		resolvePosition = traceMapFactory(sourceMapRaw);
	} catch {
		// No source map — native Luau file, passthrough mode
	}

	const sourceMapDirectory = path.posix.dirname(record.sourceMapPath);

	return {
		coverageMap: result.map,
		resolvePosition,
		sourceKey: record.key,
		sourceMapDirectory,
	};
}
