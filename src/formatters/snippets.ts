import assert from "node:assert";

import {
	getSourceSnippet,
	type MappedLocation,
	type SourceMapper,
} from "../source-mapper/index.ts";
import type { Styles } from "../terminal/palette.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { FailureLocation, SnippetSource } from "./failure-model.ts";
import { formatSourceSnippet } from "./snippet-render.ts";

interface SnippetStyle {
	rootDir?: string | undefined;
	styles: Styles;
}

interface TsSnippetOptions {
	fileSystem: FileSystem;
	loc: MappedLocation;
	rootDir?: string | undefined;
	showLuau: boolean;
	styles: Styles;
	tsLine: number;
	tsPath: string;
}

/**
 * Renders the failure model's snippet sources; a snapshot failure whose
 * sources show nothing falls back to the lone `toMatchSnapshot` call in its
 * test file.
 * @param options - Snippet sources, test file and palette.
 * @returns Snippet lines, or none when no source location is readable.
 */
export function resolveSourceSnippets({
	filePath,
	fileSystem = nodeFileSystem,
	hasSnapshotDiff,
	rootDir,
	showLuau,
	sourceMapper,
	sources,
	styles,
}: {
	filePath?: string | undefined;
	fileSystem?: FileSystem;
	hasSnapshotDiff: boolean;
	rootDir?: string | undefined;
	showLuau: boolean;
	sourceMapper?: SourceMapper | undefined;
	sources: Array<SnippetSource>;
	styles: Styles;
}): Array<string> {
	const lines = sources.flatMap((source) => {
		return source.kind === "mapped"
			? formatMappedLocationSnippets({
					fileSystem,
					loc: source.location,
					rootDir,
					showLuau,
					styles,
				})
			: formatLocationSnippet({ fileSystem, location: source.location, rootDir, styles });
	});
	if (lines.length > 0 || sources[0]?.kind === "mapped") {
		return lines;
	}

	if (hasSnapshotDiff && filePath !== undefined) {
		// `resolveDisplayPath` may rename `init.*` to `index.*`; read the disk
		// path.
		const resolvedPath = sourceMapper?.resolveTestFilePath(filePath) ?? filePath;
		return formatSnapshotCallSnippet({
			filePath: resolvedPath,
			fileSystem,
			rootDir,
			styles,
		});
	}

	return [];
}

function tsSnippetLines({
	fileSystem,
	loc,
	rootDir,
	showLuau,
	styles,
	tsLine,
	tsPath,
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

	const language = showLuau ? "TypeScript" : undefined;
	return [
		"",
		formatSourceSnippet({
			filePath: tsPath,
			language,
			rootDir,
			snippet: tsSnippet,
			styles,
		}),
	];
}

function luauSnippetLines({
	fileSystem,
	language,
	loc,
	rootDir,
	styles,
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
		}),
	];
}

function formatMappedLocationSnippets({
	fileSystem,
	loc,
	rootDir,
	showLuau,
	styles,
}: SnippetStyle & {
	fileSystem: FileSystem;
	loc: MappedLocation;
	showLuau: boolean;
}): Array<string> {
	const { tsLine, tsPath } = loc;

	if (tsPath === undefined || tsLine === undefined) {
		return luauSnippetLines({ fileSystem, loc, rootDir, styles });
	}

	const snippets = tsSnippetLines({
		fileSystem,
		loc,
		rootDir,
		showLuau,
		styles,
		tsLine,
		tsPath,
	});
	if (showLuau) {
		snippets.push(...luauSnippetLines({ fileSystem, language: "Luau", loc, rootDir, styles }));
	}

	return snippets;
}

function formatLocationSnippet({
	fileSystem,
	location,
	rootDir,
	styles,
}: SnippetStyle & { fileSystem: FileSystem; location: FailureLocation }): Array<string> {
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

	return ["", formatSourceSnippet({ filePath: location.path, rootDir, snippet, styles })];
}

function formatSnapshotCallSnippet({
	filePath,
	fileSystem,
	rootDir,
	styles,
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

	return ["", formatSourceSnippet({ filePath, rootDir, snippet, styles })];
}
