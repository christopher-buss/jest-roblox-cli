import assert from "node:assert";
import * as fs from "node:fs";

import type { RojoProject } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { findExpectationColumn } from "./column-finder.ts";
import { createFrameMapper, type MappedFrame } from "./frame-mapper.ts";
import { createPathResolver, luauInitToIndex } from "./path-resolver.ts";
import { parseStack } from "./stack-parser.ts";
import type { StackFrame } from "./types.ts";

export type { RojoProject } from "../types/rojo.ts";

const LEADING_SLASH = /^\//;

export interface MappedLocation {
	luauLine: number;
	luauPath: string;
	sourceContent?: string | undefined;
	tsColumn?: number | undefined;
	tsLine?: number | undefined;
	tsPath?: string | undefined;
}

export interface MappedFailure {
	locations: Array<MappedLocation>;
	message: string;
}

/**
 * Rewrites Luau stack frames to the sources they came from.
 *
 * Not pure: `resolveTestFilePath` (and so `resolveDisplayPath`, which calls it)
 * touches the filesystem — a DataModel path with no tsconfig mapping is probed
 * on disk as `.luau` then `.lua`. `mapFailureWithLocations` reads source maps
 * and TS sources off disk too.
 */
export interface SourceMapper {
	mapFailureWithLocations(message: string): MappedFailure;
	resolveDisplayPath(testFilePath: string): string;
	resolveTestFilePath(testFilePath: string): string | undefined;
}

export interface SourceMapperConfig {
	mappings: ReadonlyArray<TsconfigMapping>;
	rojoProject: RojoProject;
}

export interface SourceSnippet {
	column?: number | undefined;
	failureLine: number;
	lines: Array<{ content: string; num: number }>;
}

export function createSourceMapper(config: SourceMapperConfig): SourceMapper {
	const pathResolver = createPathResolver(config.rojoProject, {
		mappings: config.mappings,
	});

	const mapFrame = createFrameMapper(pathResolver);

	return {
		mapFailureWithLocations(message: string): MappedFailure {
			return rewriteFrames(message, mapFrame);
		},

		resolveDisplayPath(testFilePath: string): string {
			const resolved = resolveTestFilePath(testFilePath) ?? testFilePath;
			return config.mappings.length > 0 ? luauInitToIndex(resolved) : resolved;
		},

		resolveTestFilePath,
	};

	function resolveTestFilePath(testFilePath: string): string | undefined {
		const normalized = testFilePath.replace(LEADING_SLASH, "");
		const dataModelPath = normalized.replaceAll("/", ".");
		return pathResolver.resolve(dataModelPath)?.filePath;
	}
}

/**
 * Compose multiple `SourceMapper`s into one that tries every child in order.
 * Used by the multi-project CLI path so that failure messages and GitHub
 * annotations can resolve frames from any project's TS/Luau mapping.
 *
 * Each child mapper only rewrites frames it can resolve, leaving the rest
 * untouched. Chaining `mapFailureWithLocations` calls through every child is
 * therefore safe: later mappers see the partially rewritten string and still
 * parse any remaining `[string "..."]` frames. Locations accumulate across
 * mappers; `resolveTestFilePath` returns the first child's hit.
 */
export function combineSourceMappers(
	mappers: ReadonlyArray<SourceMapper>,
): SourceMapper | undefined {
	if (mappers.length === 0) {
		return undefined;
	}

	if (mappers.length === 1) {
		// Safe: length checked above.
		// eslint-disable-next-line ts/no-non-null-assertion -- length check
		return mappers[0]!;
	}

	return {
		mapFailureWithLocations(message: string): MappedFailure {
			return chainFailures(mappers, message);
		},

		resolveDisplayPath(testFilePath: string): string {
			return (
				findOwningMapper(mappers, testFilePath)?.resolveDisplayPath(testFilePath) ??
				testFilePath
			);
		},

		resolveTestFilePath(testFilePath: string): string | undefined {
			return findOwningMapper(mappers, testFilePath)?.resolveTestFilePath(testFilePath);
		},
	};
}

export function getSourceSnippet({
	column,
	context = 2,
	filePath,
	line,
	sourceContent,
}: {
	column?: number | undefined;
	context?: number | undefined;
	filePath: string;
	line: number;
	sourceContent?: string | undefined;
}): SourceSnippet | undefined {
	const content =
		sourceContent ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : undefined);
	if (content === undefined) {
		return undefined;
	}

	const allLines = content.split("\n");

	const startLine = Math.max(1, line - context);
	const endLine = Math.min(allLines.length, line + context);

	const lines: Array<{ content: string; num: number }> = [];
	for (let index = startLine; index <= endLine; index++) {
		const lineContent = allLines[index - 1];
		assert(lineContent !== undefined, `index ${index} out of bounds`);
		lines.push({ content: lineContent, num: index });
	}

	const failureLineContent = allLines[line - 1] ?? "";
	const computedColumn = column ?? findExpectationColumn(failureLineContent);

	return {
		column: computedColumn,
		failureLine: line,
		lines,
	};
}

function collectLocation(
	locations: Array<MappedLocation>,
	frame: StackFrame,
	{ luauPath, source }: MappedFrame,
): void {
	if (source === undefined) {
		// Only push the first Luau-only frame as a location — subsequent frames
		// are internal stack trace (Jest, Promise) and would produce noisy
		// snippets.
		if (locations.length === 0) {
			locations.push({ luauLine: frame.line, luauPath });
		}

		return;
	}

	locations.push({
		luauLine: frame.line,
		luauPath,
		sourceContent: source.sourceContent,
		tsColumn: source.column,
		tsLine: source.line,
		tsPath: source.path,
	});
}

function rewriteFrames(
	message: string,
	mapFrame: (frame: StackFrame) => MappedFrame | undefined,
): MappedFailure {
	const locations: Array<MappedLocation> = [];
	let mappedMessage = message;

	for (const frame of parseStack(message).frames) {
		const mapped = mapFrame(frame);
		if (mapped === undefined) {
			continue;
		}

		const original = `[string "${frame.dataModelPath}"]:${frame.line}`;
		const replacement =
			mapped.source === undefined
				? `${mapped.luauPath}:${frame.line}`
				: `${mapped.source.path}:${mapped.source.line}`;

		// `() => replacement` rather than the string itself: a `$` sequence in a
		// Windows path would otherwise be read as a replacement pattern.
		mappedMessage = mappedMessage.replace(original, () => replacement);

		collectLocation(locations, frame, mapped);
	}

	return { locations, message: mappedMessage };
}

function chainFailures(mappers: ReadonlyArray<SourceMapper>, message: string): MappedFailure {
	let mappedMessage = message;
	const locations: Array<MappedLocation> = [];
	for (const mapper of mappers) {
		const partial = mapper.mapFailureWithLocations(mappedMessage);
		mappedMessage = partial.message;
		locations.push(...partial.locations);
	}

	return { locations, message: mappedMessage };
}

/**
 * Ownership gate: only let a child act on a path it can actually resolve.
 * Without this, a roblox-ts mapper would apply `init→index` to paths owned by
 * other projects (incl. pure-Luau projects whose on-disk file is genuinely
 * `init.*`).
 *
 * @param mappers - The child mappers, tried in order.
 * @param testFilePath - The path to find an owner for.
 * @returns The first child that resolves the path, or `undefined`.
 */
function findOwningMapper(
	mappers: ReadonlyArray<SourceMapper>,
	testFilePath: string,
): SourceMapper | undefined {
	return mappers.find((mapper) => mapper.resolveTestFilePath(testFilePath) !== undefined);
}
