import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { findExpectationColumn } from "./column-finder.ts";
import type { PathResolver } from "./path-resolver.ts";
import type { StackFrame } from "./source-mapper-types.ts";
import type { V3Mapper } from "./v-3-mapper.ts";

/** A stack frame resolved to its Luau file and any TypeScript origin. */
export interface MappedFrame {
	/** The resolved Luau file path. */
	luauPath: string;
	/** Absent when the frame has no TypeScript origin. */
	source?: MappedSource | undefined;
}

/** What the mappers need to walk a DataModel path back to its source. */
export interface FrameMapperContext {
	/** Where a TypeScript source is read from when the map embeds none. */
	fileSystem: FileSystem;
	/** Resolves a DataModel path to a file path and mapping. */
	pathResolver: PathResolver;
	/** Reads the source maps beside the generated Luau. */
	v3Mapper: V3Mapper;
}

interface MappedSource {
	column?: number | undefined;
	line: number;
	path: string;
	sourceContent?: string | undefined;
}

/**
 * Build the function that maps a Luau stack frame to the file it came from.
 * @param context - The resolver, source-map reader and filesystem to walk.
 * @returns A mapper returning `undefined` for frames it cannot resolve at all.
 */
export function createFrameMapper(
	context: FrameMapperContext,
): (frame: StackFrame) => MappedFrame | undefined {
	return function mapFrame(frame): MappedFrame | undefined {
		const resolved = context.pathResolver.resolve(frame.dataModelPath);
		if (resolved === undefined) {
			return undefined;
		}

		const { luauPath } = resolved;
		if (resolved.mapping === undefined) {
			return { luauPath };
		}

		return { luauPath, source: mapToSource({ ...context, frame, luauPath }) };
	};
}

/**
 * Build the function that maps a Luau line of a test file to its source line.
 * @param context - The resolver, source-map reader and filesystem to walk.
 * @returns A mapper giving the source line, or `undefined` when unresolved.
 */
export function createLineMapper(
	context: FrameMapperContext,
): (dataModelPath: string, luauLine: number) => number | undefined {
	return function mapLine(dataModelPath, luauLine): number | undefined {
		const resolved = context.pathResolver.resolve(dataModelPath);
		if (resolved === undefined) {
			return undefined;
		}

		if (resolved.mapping === undefined) {
			return luauLine;
		}

		return context.v3Mapper.mapLineStart(resolved.luauPath, luauLine)?.line ?? undefined;
	};
}

function mapToSource({
	fileSystem,
	frame,
	luauPath,
	v3Mapper,
}: FrameMapperContext & { frame: StackFrame; luauPath: string }): MappedSource | undefined {
	const v3Result = v3Mapper.mapFromSourceMap({
		column: frame.column,
		line: frame.line,
		luauPath,
	});
	// oxlint-disable-next-line typescript/prefer-optional-chain -- explicit checks needed for type narrowing
	if (v3Result === undefined || v3Result.source === null || v3Result.line === null) {
		return undefined;
	}

	const mapDirectory = path.dirname(luauPath);
	const resolvedTsPath = normalizeWindowsPath(path.resolve(mapDirectory, v3Result.source));
	const tsLine = v3Result.line;

	const embeddedContent = v3Mapper.getSourceContent(luauPath, v3Result.source) ?? undefined;
	const tsContent =
		embeddedContent ??
		(fileSystem.existsSync(resolvedTsPath)
			? fileSystem.readFileSync(resolvedTsPath, "utf-8")
			: undefined);
	const tsColumn = findExpectationColumn(tsContent?.split("\n")[tsLine - 1]);

	return {
		column: tsColumn,
		line: tsLine,
		path: resolvedTsPath,
		sourceContent: embeddedContent,
	};
}
