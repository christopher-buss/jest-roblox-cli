import {
	LEAST_UPPER_BOUND,
	originalPositionFor,
	sourceContentFor,
	TraceMap,
} from "@jridgewell/trace-mapping";

import type { FileSystem } from "../utils/file-system.ts";

/** Reads the `.luau.map` beside a generated file. */
export interface V3Mapper {
	/** The source text the map embeds for `source`, if it embeds any. */
	getSourceContent: (luauPath: string, source: string) => null | string | undefined;
	/** The original position of a generated line and column. */
	mapFromSourceMap: (position: {
		column?: number | undefined;
		line: number;
		luauPath: string;
	}) => MappedPosition | undefined;
	/** The original position of the first mapping on a generated line. */
	mapLineStart: (luauPath: string, luauLine: number) => MappedPosition | undefined;
}

interface MappedPosition {
	column: null | number;
	line: null | number;
	source: null | string;
}

/**
 * Answers positions for a generated file from the `.map` beside it.
 * @param fileSystem - Where the `.map` files are read from.
 * @returns The mapper.
 */
export function createV3Mapper(fileSystem: FileSystem): V3Mapper {
	const getTraceMap = createTraceMapReader(fileSystem);

	return {
		getSourceContent(luauPath, source) {
			const traced = getTraceMap(luauPath);
			return traced === undefined ? undefined : sourceContentFor(traced, source);
		},
		mapFromSourceMap({ column = 0, line, luauPath }) {
			const traced = getTraceMap(luauPath);
			if (traced === undefined) {
				return;
			}

			const result = originalPositionFor(traced, { column, line });
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
