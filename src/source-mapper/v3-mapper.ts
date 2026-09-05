import {
	LEAST_UPPER_BOUND,
	originalPositionFor,
	sourceContentFor,
	TraceMap,
} from "@jridgewell/trace-mapping";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

/**
 * Reads the `.luau.map` beside a generated file and answers positions from it.
 */
export interface V3Mapper {
	/** The source text the map embeds for `source`, if it embeds any. */
	getSourceContent: (luauPath: string, source: string) => null | string | undefined;
	/** The original position of a generated line and column. */
	mapFromSourceMap: (
		luauPath: string,
		luauLine: number,
		luauColumn?: number,
	) => MappedPosition | undefined;
	/**
	 * The original position of the first mapping on a generated line, for a
	 * frame that carries no column. Biased upward: the default bias answers a
	 * column-0 query with the last mapping at or before it, which is none when
	 * the line starts with indentation.
	 */
	mapLineStart: (luauPath: string, luauLine: number) => MappedPosition | undefined;
}

interface MappedPosition {
	column: null | number;
	line: null | number;
	source: null | string;
}

/** Answers positions for a generated file from the `.map` beside it. */
export function createV3Mapper(fileSystem: FileSystem = nodeFileSystem): V3Mapper {
	const getTraceMap = createTraceMapReader(fileSystem);

	return {
		getSourceContent(luauPath, source) {
			const traced = getTraceMap(luauPath);
			return traced === undefined ? undefined : sourceContentFor(traced, source);
		},
		mapFromSourceMap(luauPath, luauLine, luauColumn = 0) {
			const traced = getTraceMap(luauPath);
			if (traced === undefined) {
				return;
			}

			const result = originalPositionFor(traced, { column: luauColumn, line: luauLine });
			return result.line === null ? undefined : result;
		},
		mapLineStart(luauPath, luauLine) {
			const traced = getTraceMap(luauPath);
			if (traced === undefined) {
				return;
			}

			const result = originalPositionFor(traced, {
				bias: LEAST_UPPER_BOUND,
				column: 0,
				line: luauLine,
			});
			return result.line === null ? undefined : result;
		},
	};
}

/**
 * Reads each `.luau.map` once and answers from the parsed trace thereafter: a
 * mapper reads a file more than once per run, and parsing is the expensive
 * half.
 *
 * The cache is per-reader rather than module-scoped, because a cache at module
 * scope is state one spec file leaves behind for the next. Nothing is lost by
 * it — there is no run in which two mappers read the same `outDir`, since each
 * belongs to one project.
 *
 * @param fileSystem - Where the `.map` files are read from.
 */
function createTraceMapReader(fileSystem: FileSystem): (luauPath: string) => TraceMap | undefined {
	const mapCache = new Map<string, TraceMap>();

	return function getTraceMap(luauPath) {
		let traced = mapCache.get(luauPath);
		if (traced !== undefined) {
			return traced;
		}

		const mapPath = `${luauPath}.map`;
		if (!fileSystem.existsSync(mapPath)) {
			return;
		}

		const raw = fileSystem.readFileSync(mapPath, "utf-8");
		traced = new TraceMap(raw);
		mapCache.set(luauPath, traced);
		return traced;
	};
}
