import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { replacePrefix } from "../utils/tsconfig-mapping.ts";
import { findExpectationColumn } from "./column-finder.ts";
import type { PathResolver } from "./path-resolver.ts";
import type { StackFrame } from "./types.ts";
import { getSourceContent, mapFromSourceMap, mapLineStart } from "./v3-mapper.ts";

const TS_EXTENSION = /\.ts$/;

export interface MappedFrame {
	luauPath: string;
	/** Absent when the frame has no TypeScript origin (pure-Luau project). */
	source?: MappedSource | undefined;
}

interface MappedSource {
	column?: number | undefined;
	line: number;
	path: string;
	sourceContent?: string | undefined;
}

/**
 * Builds the one function that turns a Luau stack frame into the file it came
 * from. It owns the whole chain behind that: Rojo DataModel → filesystem
 * resolution, the tsconfig `rootDir`↔`outDir` inverse, `.ts` → `.luau`, the v3
 * source map lookup, reading the TS source (embedded `sourcesContent` first,
 * disk otherwise), and finding the expectation column on the mapped line.
 *
 * @param pathResolver - Resolves a DataModel path to a file path and mapping.
 * @returns A mapper returning `undefined` for frames it cannot resolve at all.
 */
export function createFrameMapper(
	pathResolver: PathResolver,
): (frame: StackFrame) => MappedFrame | undefined {
	return function mapFrame(frame): MappedFrame | undefined {
		const resolved = pathResolver.resolve(frame.dataModelPath);
		if (resolved === undefined) {
			return undefined;
		}

		// No matched tsconfig mapping — path is Luau, skip source map lookup.
		if (resolved.mapping === undefined) {
			return { luauPath: resolved.filePath };
		}

		const { filePath, mapping } = resolved;
		const luauPath = replacePrefix(filePath, mapping.rootDir, mapping.outDir).replace(
			TS_EXTENSION,
			".luau",
		);

		return { luauPath, source: mapToSource(luauPath, frame) };
	};
}

/**
 * Builds the function that turns a Luau line of a test file into the line of
 * its source. Shares the frame mapper's path chain up to the `.luau` path, then
 * asks the source map for the first mapping on that line rather than an exact
 * column, because the runtime reports test call sites without one.
 *
 * @param pathResolver - Resolves a DataModel path to a file path and mapping.
 * @returns A mapper giving the source line, the Luau line itself for a file
 *   with no TypeScript origin, or `undefined` when it cannot resolve the path
 *   or the map has nothing on the line.
 */
export function createLineMapper(
	pathResolver: PathResolver,
): (dataModelPath: string, luauLine: number) => number | undefined {
	return function mapLine(dataModelPath, luauLine): number | undefined {
		const resolved = pathResolver.resolve(dataModelPath);
		if (resolved === undefined) {
			return undefined;
		}

		if (resolved.mapping === undefined) {
			return luauLine;
		}

		const luauPath = replacePrefix(
			resolved.filePath,
			resolved.mapping.rootDir,
			resolved.mapping.outDir,
		).replace(TS_EXTENSION, ".luau");

		return mapLineStart(luauPath, luauLine)?.line ?? undefined;
	};
}

function mapToSource(luauPath: string, frame: StackFrame): MappedSource | undefined {
	const v3Result = mapFromSourceMap(luauPath, frame.line, frame.column);
	// eslint-disable-next-line ts/prefer-optional-chain -- explicit checks needed for type narrowing
	if (v3Result === undefined || v3Result.source === null || v3Result.line === null) {
		return undefined;
	}

	const mapDirectory = path.dirname(luauPath);
	const resolvedTsPath = normalizeWindowsPath(path.resolve(mapDirectory, v3Result.source));
	const tsLine = v3Result.line;

	const embeddedContent = getSourceContent(luauPath, v3Result.source) ?? undefined;
	const tsContent =
		embeddedContent ??
		(fs.existsSync(resolvedTsPath) ? fs.readFileSync(resolvedTsPath, "utf-8") : undefined);
	const tsColumn =
		tsContent !== undefined
			? findExpectationColumn(tsContent.split("\n")[tsLine - 1] ?? "")
			: undefined;

	return {
		column: tsColumn,
		line: tsLine,
		path: resolvedTsPath,
		sourceContent: embeddedContent,
	};
}
