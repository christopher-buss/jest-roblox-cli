import type { getSourceSnippet, MappedLocation, SourceMapper } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult } from "../types/jest-result-types.ts";
import {
	type FailureDetail,
	failureDetail,
	type FailureLocation,
	locateFailure,
	type SnippetSource,
	snippetSources,
} from "./failure-model.ts";
import { makeRelative, resolveDisplayPath } from "./shared.ts";

/**
 * Reads the source lines around a location.
 */
export type SourceSnippetReader = typeof getSourceSnippet;

/**
 * Options of one agent failure.
 */
export interface FailureFormatOptions {
	/**
	 * Reads the source lines a snippet shows.
	 */
	getSourceSnippet: SourceSnippetReader;
	/**
	 * Directory that failure paths are shown relative to.
	 */
	rootDir: string;
	/**
	 * Maps Luau paths and locations back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
}

/**
 * One failed test with the display path and options it renders with.
 */
export interface AgentFailure {
	/** Display path of the test file. */
	filePath: string;
	/** Options the failure renders with. */
	options: FailureFormatOptions;
	/** The failed test. */
	test: TestCaseResult;
}

type SnippetLevel = "both" | "none" | "ts-only";

interface SnippetContext {
	getSnippet: SourceSnippetReader;
	rootDir: string;
	snippetLevel: SnippetLevel;
}

/**
 * Every failed test of one result, with its display path.
 * @param result - Result whose failed tests to collect.
 * @param options - Options the failures render with.
 * @returns The failures in file order.
 */
export function collectAgentFailures(
	result: JestResult,
	options: FailureFormatOptions,
): Array<AgentFailure> {
	return result.testResults.flatMap((file) => {
		const filePath = resolveDisplayPath(file.testFilePath, options);
		return file.testResults
			.filter((test) => test.status === "failed")
			.map((test) => {
				return { filePath, options, test };
			});
	});
}

/**
 * Render failed tests for the agent formatter, up to `maxFailures` across the
 * whole run.
 * @param options - The failures, the cap and the failure total.
 * @param options.failures - Every failed test in the run, in order.
 * @param options.maxFailures - Most failures to render.
 * @param options.totalFailures - Failure total that picks how many snippets
 *   each failure shows.
 * @returns Output lines, ending with an omitted-count line when capped.
 */
export function formatFailures({
	failures,
	maxFailures,
	totalFailures,
}: {
	failures: Array<AgentFailure>;
	maxFailures: number;
	totalFailures: number;
}): Array<string> {
	const lines: Array<string> = [];
	const snippetLevel = getSnippetLevel(totalFailures);

	for (const [index, failure] of failures.entries()) {
		if (index >= maxFailures) {
			lines.push(`... ${failures.length - index} more failures omitted`, "");
			break;
		}

		lines.push(formatAgentFailure({ ...failure, snippetLevel }));
	}

	return lines;
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

function getLocationSnippet(
	location: FailureLocation,
	getSnippet: SourceSnippetReader,
): Array<string> {
	const snippet = formatSnippetBlock(
		getSnippet({ context: 1, filePath: location.path, line: location.line }),
	);

	return snippet !== undefined ? [snippet] : [];
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

function getMappedSnippets(loc: MappedLocation, context: SnippetContext): Array<string> {
	if (loc.tsPath !== undefined && loc.tsLine !== undefined) {
		return getTsSnippets({ ...loc, tsLine: loc.tsLine, tsPath: loc.tsPath }, context);
	}

	return getLocationSnippet({ line: loc.luauLine, path: loc.luauPath }, context.getSnippet);
}

function getFailureSnippets(
	source: SnippetSource | undefined,
	context: SnippetContext,
): Array<string> {
	if (source === undefined || context.snippetLevel === "none") {
		return [];
	}

	return source.kind === "mapped"
		? getMappedSnippets(source.location, context)
		: getLocationSnippet(source.location, context.getSnippet);
}

function detailLines(detail: FailureDetail, message: string): Array<string> {
	switch (detail.kind) {
		case "message": {
			return [message];
		}
		case "snapshot": {
			return [detail.diff];
		}
		case "values": {
			return [`Expected: ${detail.expected}`, `Received: ${detail.received}`];
		}
	}
}

function formatFailureMessage({
	filePath,
	options,
	originalMessage,
	snippetLevel,
	test,
}: AgentFailure & { originalMessage: string; snippetLevel: SnippetLevel }): Array<string> {
	const located = locateFailure(originalMessage, options.sourceMapper);
	const relativePath = makeRelative(located.primary?.path ?? filePath, options.rootDir);
	const lineInfo = located.primary !== undefined ? `:${located.primary.line}` : "";
	const ancestors = test.ancestorTitles.length > 0 ? ` > ${test.ancestorTitles.join(" > ")}` : "";
	const [source] = snippetSources(located);

	return [
		` FAIL ${relativePath}${lineInfo}${ancestors} > ${test.title}`,
		...detailLines(failureDetail(located.parsed), located.parsed.message),
		...getFailureSnippets(source, {
			getSnippet: options.getSourceSnippet,
			rootDir: options.rootDir,
			snippetLevel,
		}),
		"",
	];
}

function formatAgentFailure(failure: AgentFailure & { snippetLevel: SnippetLevel }): string {
	return failure.test.failureMessages
		.flatMap((originalMessage) => formatFailureMessage({ ...failure, originalMessage }))
		.join("\n");
}
