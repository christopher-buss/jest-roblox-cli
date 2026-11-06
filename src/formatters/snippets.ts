import assert from "node:assert";

import {
	getSourceSnippet,
	type MappedLocation,
	type SourceMapper,
} from "../source-mapper/index.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { formatSourceSnippet } from "./snippet-render.ts";
import type { Styles } from "./styles.ts";

// The path segment is length-bounded so an unanchored `.match` over a long
// message stays linear (an unbounded run of non-colon chars backtracks per
// start position); 512 clears any real source path.
const SOURCE_LOCATION = /([^\s:]{1,512}\.(?:tsx?|luau?)):(\d+)(?::(\d+))?/;
interface SourceLocation {
	column?: number | undefined;
	line: number;
	path: string;
}

interface SnippetStyle {
	rootDir?: string | undefined;
	styles: Styles;
	useColor: boolean;
}

interface TsSnippetOptions {
	fileSystem: FileSystem;
	loc: MappedLocation;
	rootDir?: string | undefined;
	showLuau: boolean;
	styles: Styles;
	/** Narrowed by the caller; see `tsSnippetLines`. */
	tsLine: number;
	/** Narrowed by the caller; see `tsSnippetLines`. */
	tsPath: string;
	useColor: boolean;
}

/**
 * Find the first `path.ts:line[:column]` or Luau equivalent in a message.
 * @param message - Failure message to scan.
 * @returns The parsed location, or undefined when the message holds none.
 */
export function parseSourceLocation(message: string): SourceLocation | undefined {
	// Match patterns like "path/to/file.ts:25" or "path/to/file.ts:25:12"
	const match = message.match(SOURCE_LOCATION);
	if (match === null) {
		return undefined;
	}

	const [, filePath, lineStr, columnStr] = match;
	assert(filePath !== undefined);
	assert(lineStr !== undefined);

	return {
		column: columnStr !== undefined ? Number.parseInt(columnStr, 10) : undefined,
		line: Number.parseInt(lineStr, 10),
		path: filePath,
	};
}

/**
 * Picks the snippets that best explain a failure: the mapped locations when the
 * source mapper resolved any, else a location parsed out of the raw message,
 * else the lone `toMatchSnapshot` call in the test file.
 * @param options - Failure message, its mapped locations, test file and palette.
 * @returns Snippet lines, or none when no source location is readable.
 */
export function resolveSourceSnippets({
	filePath,
	fileSystem = nodeFileSystem,
	hasSnapshotDiff,
	mappedLocations,
	message,
	rootDir,
	showLuau,
	sourceMapper,
	styles,
	useColor,
}: {
	filePath?: string | undefined;
	fileSystem?: FileSystem;
	hasSnapshotDiff: boolean;
	mappedLocations: Array<MappedLocation>;
	message: string;
	rootDir?: string | undefined;
	showLuau: boolean;
	sourceMapper?: SourceMapper | undefined;
	styles: Styles;
	useColor: boolean;
}): Array<string> {
	if (mappedLocations.length > 0) {
		return mappedLocations.flatMap((loc) => {
			return formatMappedLocationSnippets({
				fileSystem,
				loc,
				rootDir,
				showLuau,
				styles,
				useColor,
			});
		});
	}

	const fallback = formatFallbackSnippet({ fileSystem, message, rootDir, styles, useColor });
	if (fallback.length > 0) {
		return fallback;
	}

	if (hasSnapshotDiff && filePath !== undefined) {
		// File I/O: need a real on-disk path. `resolveDisplayPath` may rewrite
		// `init.spec.luau` → `index.spec.luau` for roblox-ts, but the on-disk
		// file is still `init.*`, so reading would fail and the snippet would
		// silently disappear.
		const resolvedPath = sourceMapper?.resolveTestFilePath(filePath) ?? filePath;
		return formatSnapshotCallSnippet({
			filePath: resolvedPath,
			fileSystem,
			rootDir,
			styles,
			useColor,
		});
	}

	return [];
}

/**
 * `tsLine`/`tsPath` arrive already narrowed from the caller — the only caller
 * branches on them to pick between this and the Luau-only rendering, so
 * re-checking them here would be an unreachable guard.
 * @param options - Mapped location, narrowed TypeScript position and palette.
 * @returns Snippet lines, or none when the TypeScript source is unreadable.
 */
function tsSnippetLines({
	fileSystem,
	loc,
	rootDir,
	showLuau,
	styles,
	tsLine,
	tsPath,
	useColor,
}: TsSnippetOptions): Array<string> {
	const tsSnippet = getSourceSnippet({
		column: loc.tsColumn,
		context: 2,
		filePath: tsPath,
		fileSystem,
		line: tsLine,
		sourceContent: loc.sourceContent,
	});
	if (tsSnippet === undefined) {
		return [];
	}

	// The label only earns its space when the Luau snippet follows it.
	const language = showLuau ? "TypeScript" : undefined;
	return [
		"",
		formatSourceSnippet({
			filePath: tsPath,
			language,
			rootDir,
			snippet: tsSnippet,
			styles,
			useColor,
		}),
	];
}

function luauSnippetLines({
	fileSystem,
	language,
	loc,
	rootDir,
	styles,
	useColor,
}: SnippetStyle & {
	fileSystem: FileSystem;
	language?: string;
	loc: MappedLocation;
}): Array<string> {
	const luauSnippet = getSourceSnippet({
		context: 2,
		filePath: loc.luauPath,
		fileSystem,
		line: loc.luauLine,
	});
	if (luauSnippet === undefined) {
		return [];
	}

	return [
		"",
		formatSourceSnippet({
			filePath: loc.luauPath,
			language,
			rootDir,
			snippet: luauSnippet,
			styles,
			useColor,
		}),
	];
}

function formatMappedLocationSnippets({
	fileSystem,
	loc,
	rootDir,
	showLuau,
	styles,
	useColor,
}: SnippetStyle & {
	fileSystem: FileSystem;
	loc: MappedLocation;
	showLuau: boolean;
}): Array<string> {
	const { tsLine, tsPath } = loc;

	// Luau-only: show the Luau snippet without a language label
	if (tsPath === undefined || tsLine === undefined) {
		return luauSnippetLines({ fileSystem, loc, rootDir, styles, useColor });
	}

	// When TS fields are present, show TypeScript snippet (+ optional Luau)
	const snippets = tsSnippetLines({
		fileSystem,
		loc,
		rootDir,
		showLuau,
		styles,
		tsLine,
		tsPath,
		useColor,
	});
	if (showLuau) {
		snippets.push(
			...luauSnippetLines({ fileSystem, language: "Luau", loc, rootDir, styles, useColor }),
		);
	}

	return snippets;
}

function formatFallbackSnippet({
	fileSystem,
	message,
	rootDir,
	styles,
	useColor,
}: SnippetStyle & { fileSystem: FileSystem; message: string }): Array<string> {
	const location = parseSourceLocation(message);
	if (location === undefined) {
		return [];
	}

	const snippet = getSourceSnippet({
		column: location.column,
		context: 2,
		filePath: location.path,
		fileSystem,
		line: location.line,
	});
	if (snippet === undefined) {
		return [];
	}

	return [
		"",
		formatSourceSnippet({ filePath: location.path, rootDir, snippet, styles, useColor }),
	];
}

function formatSnapshotCallSnippet({
	filePath,
	fileSystem,
	rootDir,
	styles,
	useColor,
}: SnippetStyle & { filePath: string; fileSystem: FileSystem }): Array<string> {
	if (!fileSystem.existsSync(filePath)) {
		return [];
	}

	const content = fileSystem.readFileSync(filePath, "utf-8");
	const fileLines = content.split("\n");
	const snapshotIndices = fileLines.reduce<Array<number>>((...[accumulator, fileLine, index]) => {
		if (fileLine.includes("toMatchSnapshot")) {
			accumulator.push(index);
		}

		return accumulator;
	}, []);
	if (snapshotIndices.length !== 1) {
		return [];
	}

	// oxlint-disable-next-line typescript/no-non-null-assertion -- length checked above
	const line = snapshotIndices[0]! + 1;
	const snippet = getSourceSnippet({ context: 2, filePath, line, sourceContent: content });
	assert(snippet !== undefined);

	return ["", formatSourceSnippet({ filePath, rootDir, snippet, styles, useColor })];
}
