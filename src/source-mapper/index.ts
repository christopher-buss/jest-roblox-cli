import assert from "node:assert";

import type { RojoProject } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { findExpectationColumn } from "./column-finder.ts";
import { createFrameMapper, createLineMapper, type MappedFrame } from "./frame-mapper.ts";
import { createPathResolver, luauInitToIndex } from "./path-resolver.ts";
import type { StackFrame } from "./source-mapper-types.ts";
import { parseStack } from "./stack-parser.ts";
import { createV3Mapper } from "./v-3-mapper.ts";

const LEADING_SLASH = /^\//;

/** One stack frame of a failure, with its TypeScript origin when mapped. */
export interface MappedLocation {
	/** The frame's Luau line. */
	luauLine: number;
	/** The frame's Luau file path. */
	luauPath: string;
	/** The TypeScript source embedded in the map, when present. */
	sourceContent?: string | undefined;
	/** The mapped TypeScript column. */
	tsColumn?: number | undefined;
	/** The mapped TypeScript line. */
	tsLine?: number | undefined;
	/** The mapped TypeScript file path. */
	tsPath?: string | undefined;
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
	/** Rewrite each resolvable frame in a failure message and list them. */
	mapFailureWithLocations(message: string): MappedFailure;
	/**
	 * The line of the file `resolveTestFilePath` names that a Luau line of the
	 * test file came from: the TypeScript line through the source map when
	 * there is one, the Luau line itself otherwise. Undefined when the path
	 * does not resolve or the map has nothing on that line.
	 */
	mapTestFileLine(testFilePath: string, luauLine: number): number | undefined;
	/** The path to show for a test file: its source path, else the input. */
	resolveDisplayPath(testFilePath: string): string;
	/** The on-disk file a Jest test path resolves to, if any. */
	resolveTestFilePath(testFilePath: string): string | undefined;
}

/** Inputs for {@link createSourceMapper}. */
export interface SourceMapperConfig {
	/** Where sources and maps are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** The tsconfig source and output roots to map through. */
	mappings: ReadonlyArray<TsconfigMapping>;
	/** The Rojo project that places files in the DataModel. */
	rojoProject: RojoProject;
	/** Folder relative mounts resolve in; without it, paths stay relative. */
	rootDirectory?: string | undefined;
}

/** Source lines around a failure, for display. */
export interface SourceSnippet {
	/** The 1-indexed failure column, when known. */
	column?: number | undefined;
	/** The 1-indexed failing line. */
	failureLine: number;
	/** The lines shown, each with its 1-indexed number. */
	lines: Array<{
		/** The line text. */
		content: string;
		/** The 1-indexed line number. */
		num: number;
	}>;
}

interface MappedFailure {
	locations: Array<MappedLocation>;
	message: string;
}

/**
 * Build a source mapper for one project.
 * @param config - The Rojo project, tsconfig mappings and filesystem.
 * @param config.fileSystem - Where sources and maps are read.
 * @param config.mappings - The tsconfig roots to map through.
 * @param config.rojoProject - The Rojo project to resolve paths against.
 * @param config.rootDirectory - Directory relative mounts resolve in.
 * @returns A mapper that rewrites frames through this project's maps.
 */
export function createSourceMapper({
	fileSystem = nodeFileSystem,
	mappings,
	rojoProject,
	rootDirectory,
}: SourceMapperConfig): SourceMapper {
	const pathResolver = createPathResolver(rojoProject, { fileSystem, mappings, rootDirectory });

	const context = { fileSystem, pathResolver, v3Mapper: createV3Mapper(fileSystem) };
	const mapFrame = createFrameMapper(context);
	const mapLine = createLineMapper(context);

	return {
		mapFailureWithLocations(message: string): MappedFailure {
			return rewriteFrames(message, mapFrame);
		},

		mapTestFileLine(testFilePath: string, luauLine: number): number | undefined {
			return mapLine(toDataModelPath(testFilePath), luauLine);
		},

		resolveDisplayPath(testFilePath: string): string {
			const resolved = resolveTestFilePath(testFilePath) ?? testFilePath;
			return mappings.length > 0 ? luauInitToIndex(resolved) : resolved;
		},

		resolveTestFilePath,
	};

	function resolveTestFilePath(testFilePath: string): string | undefined {
		return pathResolver.resolve(toDataModelPath(testFilePath))?.filePath;
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
 * @param mappers - The child mappers, tried in order.
 * @returns The sole child, a composite, or `undefined` for none.
 */
export function combineSourceMappers(
	mappers: ReadonlyArray<SourceMapper>,
): SourceMapper | undefined {
	if (mappers.length === 0) {
		return undefined;
	}

	if (mappers.length === 1) {
		// Safe: length checked above.
		// oxlint-disable-next-line typescript/no-non-null-assertion -- length check
		return mappers[0]!;
	}

	return {
		mapFailureWithLocations(message: string): MappedFailure {
			return chainFailures(mappers, message);
		},

		mapTestFileLine(testFilePath: string, luauLine: number): number | undefined {
			return findOwningMapper(mappers, testFilePath)?.mapTestFileLine(testFilePath, luauLine);
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

/**
 * Read the source lines around a failing line.
 * @param options - The file, the line and how much context to show.
 * @param options.column - The failure column; found from an `expect` if absent.
 * @param options.context - Lines to show either side; defaults to 2.
 * @param options.filePath - The source file to read.
 * @param options.fileSystem - Where the file is read.
 * @param options.line - The 1-indexed failing line.
 * @param options.sourceContent - Source text to use in place of reading.
 * @returns The snippet, or `undefined` when the file is absent.
 */
export function getSourceSnippet({
	column,
	context = 2,
	filePath,
	fileSystem = nodeFileSystem,
	line,
	sourceContent,
}: {
	column?: number | undefined;
	context?: number | undefined;
	filePath: string;
	fileSystem?: FileSystem;
	line: number;
	sourceContent?: string | undefined;
}): SourceSnippet | undefined {
	const content =
		sourceContent ??
		(fileSystem.existsSync(filePath) ? fileSystem.readFileSync(filePath, "utf-8") : undefined);
	if (content === undefined) {
		return undefined;
	}

	const allLines = content.split("\n");

	const startLine = Math.max(1, line - context);
	const endLine = Math.min(allLines.length, line + context);

	const lines: Array<{ content: string; num: number }> = [];
	for (let index = startLine; index <= endLine; index++) {
		const lineContent = allLines[index - 1];
		assert(lineContent !== undefined);
		lines.push({ content: lineContent, num: index });
	}

	const failureLineContent = allLines[line - 1];
	const computedColumn = column ?? findExpectationColumn(failureLineContent);

	return {
		column: computedColumn,
		failureLine: line,
		lines,
	};
}

/**
 * Jest's slash-joined test path (optionally leading-slashed) as a DataModel
 * path.
 * @param testFilePath - The Jest test path.
 * @returns The dotted DataModel path.
 */
function toDataModelPath(testFilePath: string): string {
	return testFilePath.replace(LEADING_SLASH, "").replaceAll("/", ".");
}

function collectLocation({
	frame,
	locations,
	mapped: { luauPath, source },
}: {
	frame: StackFrame;
	locations: Array<MappedLocation>;
	mapped: MappedFrame;
}): void {
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

		collectLocation({ frame, locations, mapped });
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
 * other projects (including pure-Luau projects whose on-disk file is genuinely
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
