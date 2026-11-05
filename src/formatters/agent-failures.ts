import path from "node:path";

import type { getSourceSnippet, MappedLocation, SourceMapper } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult } from "../types/jest-result-types.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { parseErrorMessage } from "./failure.ts";
import { resolveDisplayPath } from "./shared.ts";
import { parseSourceLocation } from "./snippets.ts";

/**
 * Reads the source lines around a location.
 */
export type SourceSnippetReader = typeof getSourceSnippet;

/**
 * Options of the agent failure list.
 */
export interface FailureFormatOptions {
	/**
	 * Reads the source lines a snippet shows.
	 */
	getSourceSnippet: SourceSnippetReader;
	/**
	 * Most failures to render; the rest collapse into one omitted line.
	 */
	maxFailures: number;
	/**
	 * Directory that failure paths are shown relative to.
	 */
	rootDir: string;
	/**
	 * Maps Luau paths and locations back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
}

type SnippetLevel = "both" | "none" | "ts-only";

interface SnippetContext {
	getSnippet: SourceSnippetReader;
	rootDir: string;
	snippetLevel: SnippetLevel;
}

interface FormatFailureMessageOptions {
	agentOptions: FailureFormatOptions;
	filePath: string;
	originalMessage: string;
	snippetLevel: SnippetLevel;
	test: TestCaseResult;
}

interface FormatAgentFailureOptions {
	filePath: string;
	options: FailureFormatOptions;
	snippetLevel: SnippetLevel;
	test: TestCaseResult;
}

/**
 * Show a path relative to a root it lies under.
 * @param filePath - Path to shorten.
 * @param rootDirectory - Root to shorten against.
 * @returns The relative path with forward slashes, or `filePath` unchanged when outside the root.
 */
export function makeRelative(filePath: string, rootDirectory: string): string {
	const normalizedPath = normalizeWindowsPath(filePath);
	const normalizedRoot = normalizeWindowsPath(rootDirectory);

	if (normalizedPath.startsWith(normalizedRoot)) {
		return normalizeWindowsPath(path.relative(normalizedRoot, normalizedPath));
	}

	return filePath;
}

/**
 * Render each failed test for the agent formatter, up to `maxFailures`.
 * @param options - Formatter options, the run result and its failure total.
 * @returns Output lines, ending with an omitted-count line when capped.
 */
export function formatFailures({
	options,
	result,
	totalFailures,
}: {
	/**
	 * Formatter options.
	 */
	options: FailureFormatOptions;
	/**
	 * Run result whose failed tests to render.
	 */
	result: JestResult;
	/**
	 * Failure total that picks how many snippets each failure shows.
	 */
	totalFailures: number;
}): Array<string> {
	const lines: Array<string> = [];
	const failures = collectFailedTests(result, options.sourceMapper);
	const snippetLevel = getSnippetLevel(totalFailures);

	for (const [index, failure] of failures.entries()) {
		if (index >= options.maxFailures) {
			lines.push(`... ${result.numFailedTests - index} more failures omitted`, "");
			break;
		}

		lines.push(formatAgentFailure({ ...failure, options, snippetLevel }));
	}

	return lines;
}

function collectFailedTests(
	result: JestResult,
	sourceMapper?: SourceMapper,
): Array<{ filePath: string; test: TestCaseResult }> {
	const failures: Array<{ filePath: string; test: TestCaseResult }> = [];

	for (const file of result.testResults) {
		const displayPath = resolveDisplayPath(file.testFilePath, sourceMapper);
		for (const test of file.testResults) {
			if (test.status === "failed") {
				failures.push({ filePath: displayPath, test });
			}
		}
	}

	return failures;
}

function getSnippetLevel(totalFailures: number): SnippetLevel {
	if (totalFailures <= 2) {
		return "both";
	}

	if (totalFailures <= 5) {
		return "ts-only";
	}

	return "none";
}

function findFailureLocation(
	mappedLocations: Array<MappedLocation>,
	message: string,
): undefined | { line: number; path: string } {
	const [loc] = mappedLocations;
	if (loc !== undefined) {
		if (loc.tsPath !== undefined && loc.tsLine !== undefined) {
			return { line: loc.tsLine, path: loc.tsPath };
		}

		return { line: loc.luauLine, path: loc.luauPath };
	}

	return parseSourceLocation(message);
}

function formatSnippetBlock(snippetResult: ReturnType<SourceSnippetReader>): string | undefined {
	if (snippetResult === undefined) {
		return undefined;
	}

	const lines: Array<string> = [];
	for (const line of snippetResult.lines) {
		const prefix = line.num === snippetResult.failureLine ? ">" : " ";
		lines.push(`${prefix} ${line.num}| ${line.content}`);
	}

	return lines.join("\n");
}

function getTsSnippets(
	loc: MappedLocation & { tsLine: number; tsPath: string },
	{ getSnippet, rootDir, snippetLevel }: SnippetContext,
): Array<string> {
	const result: Array<string> = [];

	const tsSnippet = formatSnippetBlock(
		getSnippet({
			column: loc.tsColumn,
			context: 1,
			filePath: loc.tsPath,
			line: loc.tsLine,
			sourceContent: loc.sourceContent,
		}),
	);

	if (tsSnippet !== undefined) {
		const relativeTsPath = makeRelative(loc.tsPath, rootDir);
		const label = snippetLevel === "both" ? `TS  ${relativeTsPath}:${loc.tsLine}\n` : "";
		result.push(`${label}${tsSnippet}`);
	}

	if (snippetLevel === "both") {
		const luauSnippet = formatSnippetBlock(
			getSnippet({ context: 1, filePath: loc.luauPath, line: loc.luauLine }),
		);

		if (luauSnippet !== undefined) {
			const relativeLuauPath = makeRelative(loc.luauPath, rootDir);
			result.push(`Luau  ${relativeLuauPath}:${loc.luauLine}\n${luauSnippet}`);
		}
	}

	return result;
}

function getLuauOnlySnippet(loc: MappedLocation, getSnippet: SourceSnippetReader): Array<string> {
	const snippet = formatSnippetBlock(
		getSnippet({ context: 1, filePath: loc.luauPath, line: loc.luauLine }),
	);

	return snippet !== undefined ? [snippet] : [];
}

function getMappedSnippets(loc: MappedLocation, context: SnippetContext): Array<string> {
	if (loc.tsPath !== undefined && loc.tsLine !== undefined) {
		return getTsSnippets({ ...loc, tsLine: loc.tsLine, tsPath: loc.tsPath }, context);
	}

	return getLuauOnlySnippet(loc, context.getSnippet);
}

function getFallbackSnippet(
	location: { line: number; path: string },
	getSnippet: SourceSnippetReader,
): Array<string> {
	const snippet = formatSnippetBlock(
		getSnippet({ context: 1, filePath: location.path, line: location.line }),
	);

	return snippet !== undefined ? [snippet] : [];
}

function getFailureSnippets({
	context,
	location,
	mappedLocations,
}: {
	context: SnippetContext;
	location: undefined | { line: number; path: string };
	mappedLocations: Array<MappedLocation>;
}): Array<string> {
	if (context.snippetLevel === "none") {
		return [];
	}

	const [loc] = mappedLocations;
	if (loc !== undefined) {
		return getMappedSnippets(loc, context);
	}

	if (location !== undefined) {
		return getFallbackSnippet(location, context.getSnippet);
	}

	return [];
}

/**
 * The expectation detail under a failure header: a snapshot diff, an
 * expected/received pair, or the raw message when neither was parsed out.
 * @param parsed - Parsed failure message.
 * @returns Detail lines.
 */
function buildFailureDetail(parsed: ReturnType<typeof parseErrorMessage>): Array<string> {
	if (parsed.snapshotDiff !== undefined) {
		return [parsed.snapshotDiff];
	}

	if (parsed.expected !== undefined && parsed.received !== undefined) {
		return [`Expected: ${parsed.expected}`, `Received: ${parsed.received}`];
	}

	return [parsed.message];
}

/**
 * One failure message: the ` FAIL <file>:<line> > <test>` header, the
 * expectation detail (snapshot diff, expected/received pair, or the raw
 * message), the source snippets, and a trailing blank line.
 * @param options - Failed test, its message, file path and snippet level.
 * @returns Lines of the failure message.
 */
function formatFailureMessage({
	agentOptions,
	filePath,
	originalMessage,
	snippetLevel,
	test,
}: FormatFailureMessageOptions): Array<string> {
	const lines: Array<string> = [];

	let mappedLocations: Array<MappedLocation> = [];
	let message = originalMessage;

	if (agentOptions.sourceMapper !== undefined) {
		({ locations: mappedLocations, message } =
			agentOptions.sourceMapper.mapFailureWithLocations(originalMessage));
	}

	const parsed = parseErrorMessage(originalMessage);
	const location = findFailureLocation(mappedLocations, message);
	const relativePath = makeRelative(location?.path ?? filePath, agentOptions.rootDir);
	const lineInfo = location?.line !== undefined ? `:${location.line}` : "";
	const ancestors = test.ancestorTitles.length > 0 ? ` > ${test.ancestorTitles.join(" > ")}` : "";

	lines.push(
		` FAIL ${relativePath}${lineInfo}${ancestors} > ${test.title}`,
		...buildFailureDetail(parsed),
		...getFailureSnippets({
			context: {
				getSnippet: agentOptions.getSourceSnippet,
				rootDir: agentOptions.rootDir,
				snippetLevel,
			},
			location,
			mappedLocations,
		}),
		"",
	);

	return lines;
}

function formatAgentFailure({
	filePath,
	options,
	snippetLevel,
	test,
}: FormatAgentFailureOptions): string {
	const lines: Array<string> = [];

	for (const originalMessage of test.failureMessages) {
		lines.push(
			...formatFailureMessage({
				agentOptions: options,
				filePath,
				originalMessage,
				snippetLevel,
				test,
			}),
		);
	}

	return lines.join("\n");
}
