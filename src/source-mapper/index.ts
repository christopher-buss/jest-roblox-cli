import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import type { RojoProject } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { replacePrefix } from "../utils/tsconfig-mapping.ts";
import { findExpectationColumn } from "./column-finder.ts";
import { createPathResolver } from "./path-resolver.ts";
import { parseStack } from "./stack-parser.ts";
import { getSourceContent, mapFromSourceMap } from "./v3-mapper.ts";

export type { RojoProject } from "../types/rojo.ts";

export interface MappedLocation {
	luauLine: number;
	luauPath: string;
	sourceContent?: string;
	tsColumn?: number;
	tsLine?: number;
	tsPath?: string;
}

export interface MappedFailure {
	locations: Array<MappedLocation>;
	message: string;
}

export interface SourceMapper {
	mapFailureMessage(message: string): string;
	mapFailureWithLocations(message: string): MappedFailure;
	resolveTestFilePath(testFilePath: string): string | undefined;
}

export interface SourceMapperConfig {
	mappings: ReadonlyArray<TsconfigMapping>;
	rojoProject: RojoProject;
}

export interface SourceSnippet {
	column?: number;
	failureLine: number;
	lines: Array<{ content: string; num: number }>;
}

export function createSourceMapper(config: SourceMapperConfig): SourceMapper {
	const pathResolver = createPathResolver(config.rojoProject, {
		mappings: config.mappings,
	});

	function mapFrame(frame: { column?: number; dataModelPath: string; line: number }):
		| undefined
		| {
				luauPath: string;
				mapped:
					| undefined
					| { column?: number; line: number; path: string; sourceContent?: string };
		  } {
		const resolved = pathResolver.resolve(frame.dataModelPath);
		if (resolved === undefined) {
			return undefined;
		}

		// No matched tsconfig mapping — path is Luau, skip source map lookup.
		if (resolved.mapping === undefined) {
			return { luauPath: resolved.filePath, mapped: undefined };
		}

		const { filePath, mapping } = resolved;
		const luauPath = replacePrefix(filePath, mapping.rootDir, mapping.outDir).replace(
			/\.ts$/,
			".luau",
		);

		const v3Result = mapFromSourceMap(luauPath, frame.line, frame.column);
		// eslint-disable-next-line ts/prefer-optional-chain -- explicit checks needed for type narrowing
		if (v3Result !== undefined && v3Result.source !== null && v3Result.line !== null) {
			const mapDirectory = path.dirname(luauPath);
			const resolvedTsPath = normalizeWindowsPath(
				path.resolve(mapDirectory, v3Result.source),
			);
			const tsLine = v3Result.line;

			const embeddedContent = getSourceContent(luauPath, v3Result.source) ?? undefined;
			const tsContent =
				embeddedContent ??
				(fs.existsSync(resolvedTsPath)
					? fs.readFileSync(resolvedTsPath, "utf-8")
					: undefined);
			const tsColumn =
				tsContent !== undefined
					? findExpectationColumn(tsContent.split("\n")[tsLine - 1] ?? "")
					: undefined;

			return {
				luauPath,
				mapped: {
					column: tsColumn,
					line: tsLine,
					path: resolvedTsPath,
					sourceContent: embeddedContent,
				},
			};
		}

		return { luauPath, mapped: undefined };
	}

	return {
		mapFailureMessage(message: string): string {
			const parsed = parseStack(message);
			let result = message;

			for (const frame of parsed.frames) {
				const frameResult = mapFrame(frame);
				if (frameResult === undefined) {
					continue;
				}

				const original = `[string "${frame.dataModelPath}"]:${frame.line}`;
				if (frameResult.mapped !== undefined) {
					const mapped = `${frameResult.mapped.path}:${frameResult.mapped.line}`;
					result = result.replace(original, mapped);
				} else {
					const replacement = `${frameResult.luauPath}:${frame.line}`;
					result = result.replace(original, replacement);
				}
			}

			return result;
		},

		mapFailureWithLocations(message: string): MappedFailure {
			const parsed = parseStack(message);
			let mappedMessage = message;
			const locations: Array<MappedLocation> = [];

			for (const frame of parsed.frames) {
				const frameResult = mapFrame(frame);
				if (frameResult === undefined) {
					continue;
				}

				const original = `[string "${frame.dataModelPath}"]:${frame.line}`;
				if (frameResult.mapped !== undefined) {
					const mapped = `${frameResult.mapped.path}:${frameResult.mapped.line}`;
					mappedMessage = mappedMessage.replace(original, mapped);

					locations.push({
						luauLine: frame.line,
						luauPath: frameResult.luauPath,
						sourceContent: frameResult.mapped.sourceContent,
						tsColumn: frameResult.mapped.column,
						tsLine: frameResult.mapped.line,
						tsPath: frameResult.mapped.path,
					});
				} else {
					const replacement = `${frameResult.luauPath}:${frame.line}`;
					mappedMessage = mappedMessage.replace(original, replacement);

					// Only push the first Luau-only frame as a location —
					// subsequent frames are internal stack trace (Jest, Promise)
					// and would produce noisy snippets.
					if (locations.length === 0) {
						locations.push({
							luauLine: frame.line,
							luauPath: frameResult.luauPath,
						});
					}
				}
			}

			return { locations, message: mappedMessage };
		},

		resolveTestFilePath(testFilePath: string): string | undefined {
			const normalized = testFilePath.replace(/^\//, "");
			const dataModelPath = normalized.replaceAll("/", ".");
			return pathResolver.resolve(dataModelPath)?.filePath;
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
	column?: number;
	context?: number;
	filePath: string;
	line: number;
	sourceContent?: string;
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
