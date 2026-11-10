import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import * as path from "node:path";

import { readCoverageMap } from "../coverage-data/coverage-map.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import { readUnlessMissing } from "../coverage-data/manifest-parse.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
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
	/** Filesystem the maps are read from. */
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

type TraceMapFactory = (rawSourceMap: string) => PositionResolver;

class CoverageMapMalformedError extends Error {
	public readonly coverageMapPath: string;

	constructor(coverageMapPath: string) {
		super(
			`Coverage map at ${coverageMapPath} is malformed or invalid (re-run with \`--coverage\`)`,
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
 * @throws {Error} When a source map exists but cannot be parsed.
 */
export function mapCoverageToTypeScript({
	coverageData,
	fileSystem = nodeFileSystem,
	manifest,
	traceMapFactory = traceMappingFactory,
}: CoverageMappingOptions): MappedCoverageResult {
	const pending = createPendingCoverage();

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

function parseSourceMap({
	raw,
	sourceMapPath,
	traceMapFactory,
}: {
	raw: string;
	sourceMapPath: string;
	traceMapFactory: TraceMapFactory;
}): PositionResolver {
	try {
		return traceMapFactory(raw);
	} catch (err) {
		throw new Error(
			`Source map at ${sourceMapPath} is malformed (re-run with \`--coverage\`)`,
			{
				cause: err,
			},
		);
	}
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
	if (result.kind === "missing") {
		return undefined;
	}

	if (result.kind === "invalid") {
		throw new CoverageMapMalformedError(record.coverageMapPath);
	}

	const sourceMapRaw = readUnlessMissing(record.sourceMapPath, fileSystem);
	const resolvePosition =
		sourceMapRaw === undefined
			? undefined
			: parseSourceMap({
					raw: sourceMapRaw,
					sourceMapPath: record.sourceMapPath,
					traceMapFactory,
				});

	const sourceMapDirectory = path.posix.dirname(record.sourceMapPath);

	return {
		coverageMap: result.map,
		resolvePosition,
		sourceKey: record.key,
		sourceMapDirectory,
	};
}
