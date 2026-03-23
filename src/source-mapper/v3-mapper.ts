import { originalPositionFor, sourceContentFor, TraceMap } from "@jridgewell/trace-mapping";

import * as fs from "node:fs";

interface MappedPosition {
	column: null | number;
	line: null | number;
	source: null | string;
}

const mapCache = new Map<string, TraceMap>();

export function clearMapCache(): void {
	mapCache.clear();
}

export function getSourceContent(luauPath: string, source: string): null | string | undefined {
	const traced = getTraceMap(luauPath);
	if (traced === undefined) {
		return undefined;
	}

	return sourceContentFor(traced, source);
}

export function mapFromSourceMap(
	luauPath: string,
	luauLine: number,
	luauColumn = 0,
): MappedPosition | undefined {
	const traced = getTraceMap(luauPath);
	if (traced === undefined) {
		return undefined;
	}

	const result = originalPositionFor(traced, { column: luauColumn, line: luauLine });
	if (result.line === null) {
		return undefined;
	}

	return result;
}

function getTraceMap(luauPath: string): TraceMap | undefined {
	let traced = mapCache.get(luauPath);
	if (traced !== undefined) {
		return traced;
	}

	const mapPath = `${luauPath}.map`;
	if (!fs.existsSync(mapPath)) {
		return undefined;
	}

	const raw = fs.readFileSync(mapPath, "utf-8");
	traced = new TraceMap(raw);
	mapCache.set(luauPath, traced);
	return traced;
}
