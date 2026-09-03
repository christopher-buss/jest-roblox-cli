import path from "node:path";

import {
	getSourceSnippet,
	type MappedLocation,
	type SourceMapper,
} from "../source-mapper/index.ts";
import {
	execErrorReason,
	type ExecErrorTestFileResult,
	hasExecError,
	type JestResult,
	type TestCaseResult,
} from "../types/jest-result.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import {
	cleanExecErrorMessage,
	getExecErrorHint,
	parseErrorMessage,
	parseSourceLocation,
	resolveDisplayPath,
} from "./formatter.ts";
import type { BailSummary } from "./shared.ts";
import { createStyles } from "./styles.ts";
import {
	countFileBuckets,
	countTestBuckets,
	formatBailLine,
	formatSummaryParts,
	formatTestFilesLine,
	formatTestsLine,
	formatTypeErrorsLine,
	type SummaryCounts,
	type TestRowCounts,
} from "./summary.ts";

export interface AgentOptions {
	/** Set when `--bail` cut the run short; see {@link BailSummary}. */
	bail?: BailSummary | undefined;
	gameOutput?: string | undefined;
	gameOutputSize?: number | undefined;
	maxFailures: number;
	outputFile?: string | undefined;
	outputFileSize?: number | undefined;
	rootDir: string;
	sourceMapper?: SourceMapper | undefined;
	typeErrorCount?: number | undefined;
}

interface AgentProjectEntry {
	displayName: string;
	result: JestResult;
}

type SnippetLevel = "both" | "none" | "ts-only";

interface FormatFailureMessageOptions {
	agentOptions: AgentOptions;
	filePath: string;
	originalMessage: string;
	snippetLevel: SnippetLevel;
	test: TestCaseResult;
}

interface AgentProjectStats {
	allExecErrors: Array<ExecErrorTestFileResult>;
	files: SummaryCounts;
	tests: TestRowCounts;
}

// This formatter emits plain text only, so the shared summary rows render
// through the no-op palette rather than growing a plain-text twin.
const PLAIN_STYLES = createStyles(false);

export function formatAgent(result: JestResult, options: AgentOptions): string {
	const lines: Array<string> = [];
	const execErrors = result.testResults.filter(hasExecError);
	const hasFailures = result.numFailedTests > 0 || execErrors.length > 0;

	if (hasFailures) {
		const totalFailures = result.numFailedTests + execErrors.length;
		lines.push(
			...formatFileHeaders(result, options),
			"",
			`${"⎯".repeat(3)} Failed Tests ${totalFailures} ${"⎯".repeat(3)}`,
			"",
			...formatFailures(result, result.numFailedTests, options),
		);

		for (const file of execErrors) {
			lines.push(...formatExecError(file, options));
		}

		const hints = formatAgentLogHints(options);
		if (hints !== "") {
			lines.push(hints);
		}
	}

	lines.push(...formatSummarySection(result, options));

	return lines.join("\n");
}

export function formatAgentMultiProject(
	projects: Array<AgentProjectEntry>,
	options: AgentOptions,
): string {
	const lines: Array<string> = [];

	for (const { displayName, result } of projects) {
		lines.push(...formatAgentProjectHeader(displayName, result, options));
	}

	const stats = collectMultiProjectStats(projects);
	const totalFailures = stats.tests.counts.failed + stats.allExecErrors.length;

	if (totalFailures > 0) {
		lines.push(...formatMultiProjectFailures(projects, stats, options));
	}

	lines.push(...formatMultiProjectSummary(stats, options));

	return lines.join("\n");
}

function formatSummarySection(result: JestResult, options: AgentOptions): Array<string> {
	const lines: Array<string> = [
		formatTestFilesLine(countFileBuckets(result), PLAIN_STYLES),
		formatTestsLine(countTestBuckets(result), PLAIN_STYLES),
	];

	if (options.typeErrorCount !== undefined) {
		lines.push(formatTypeErrorsLine(options.typeErrorCount, PLAIN_STYLES));
	}

	return lines;
}

function makeRelative(filePath: string, rootDirectory: string): string {
	const normalizedPath = normalizeWindowsPath(filePath);
	const normalizedRoot = normalizeWindowsPath(rootDirectory);

	if (normalizedPath.startsWith(normalizedRoot)) {
		return normalizeWindowsPath(path.relative(normalizedRoot, normalizedPath));
	}

	return filePath;
}

function formatFileHeaderExecError(
	file: JestResult["testResults"][number],
	options: AgentOptions,
): Array<string> {
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const relativePath = makeRelative(displayPath, options.rootDir);

	return [` ❯ ${relativePath} (suite ${execErrorReason(file)})`];
}

function formatFileHeaderFailures(
	file: JestResult["testResults"][number],
	options: AgentOptions,
): Array<string> {
	const lines: Array<string> = [];
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const relativePath = makeRelative(displayPath, options.rootDir);
	const totalTests = file.numFailingTests + file.numPassingTests + file.numPendingTests;
	const testWord = totalTests === 1 ? "test" : "tests";

	lines.push(` ❯ ${relativePath} (${totalTests} ${testWord} | ${file.numFailingTests} failed)`);

	for (const test of file.testResults) {
		if (test.status !== "failed") {
			continue;
		}

		const duration = test.duration !== undefined ? ` ${String(test.duration)}ms` : "";
		lines.push(`   × ${test.title}${duration}`);
	}

	return lines;
}

function formatFileHeaders(result: JestResult, options: AgentOptions): Array<string> {
	const lines: Array<string> = [];

	for (const file of result.testResults) {
		if (hasExecError(file)) {
			lines.push(...formatFileHeaderExecError(file, options));
			continue;
		}

		if (file.numFailingTests === 0) {
			continue;
		}

		lines.push(...formatFileHeaderFailures(file, options));
	}

	return lines;
}

function formatExecError(file: ExecErrorTestFileResult, options: AgentOptions): Array<string> {
	const lines: Array<string> = [];
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const relativePath = makeRelative(displayPath, options.rootDir);

	const errorMessage = cleanExecErrorMessage(file.failureMessage);

	lines.push(` ${file.timedOut === true ? "TIMEOUT" : "FAIL"} ${relativePath}`, errorMessage);

	const hint = getExecErrorHint(errorMessage);
	if (hint !== undefined) {
		lines.push(`Hint: ${hint}`);
	}

	lines.push("");
	return lines;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}b`;
	}

	const kb = Math.round(bytes / 1024);
	return `${kb}kb`;
}

function formatAgentLogHints(options: AgentOptions): string {
	const lines: Array<string> = [];

	if (options.outputFile !== undefined) {
		const size =
			options.outputFileSize !== undefined ? ` (${formatSize(options.outputFileSize)})` : "";
		lines.push(`View ${options.outputFile} for full Jest output${size}`);
	}

	if (options.gameOutput !== undefined) {
		const size =
			options.gameOutputSize !== undefined ? ` (${formatSize(options.gameOutputSize)})` : "";
		lines.push(`View ${options.gameOutput} for Roblox game logs${size}`);
	}

	return lines.join("\n");
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

function formatSnippetBlock(
	snippetResult: ReturnType<typeof getSourceSnippet>,
): string | undefined {
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
	snippetLevel: SnippetLevel,
	rootDirectory: string,
): Array<string> {
	const result: Array<string> = [];

	const tsSnippet = formatSnippetBlock(
		getSourceSnippet({
			column: loc.tsColumn,
			context: 1,
			filePath: loc.tsPath,
			line: loc.tsLine,
			sourceContent: loc.sourceContent,
		}),
	);

	if (tsSnippet !== undefined) {
		const relativeTsPath = makeRelative(loc.tsPath, rootDirectory);
		const label = snippetLevel === "both" ? `TS  ${relativeTsPath}:${loc.tsLine}\n` : "";
		result.push(`${label}${tsSnippet}`);
	}

	if (snippetLevel === "both") {
		const luauSnippet = formatSnippetBlock(
			getSourceSnippet({ context: 1, filePath: loc.luauPath, line: loc.luauLine }),
		);

		if (luauSnippet !== undefined) {
			const relativeLuauPath = makeRelative(loc.luauPath, rootDirectory);
			result.push(`Luau  ${relativeLuauPath}:${loc.luauLine}\n${luauSnippet}`);
		}
	}

	return result;
}

function getLuauOnlySnippet(loc: MappedLocation): Array<string> {
	const snippet = formatSnippetBlock(
		getSourceSnippet({ context: 1, filePath: loc.luauPath, line: loc.luauLine }),
	);

	return snippet !== undefined ? [snippet] : [];
}

function getMappedSnippets(
	loc: MappedLocation,
	snippetLevel: SnippetLevel,
	rootDirectory: string,
): Array<string> {
	if (loc.tsPath !== undefined && loc.tsLine !== undefined) {
		return getTsSnippets(
			{ ...loc, tsLine: loc.tsLine, tsPath: loc.tsPath },
			snippetLevel,
			rootDirectory,
		);
	}

	return getLuauOnlySnippet(loc);
}

function getFallbackSnippet(location: { line: number; path: string }): Array<string> {
	const snippet = formatSnippetBlock(
		getSourceSnippet({ context: 1, filePath: location.path, line: location.line }),
	);

	return snippet !== undefined ? [snippet] : [];
}

function getFailureSnippets(
	mappedLocations: Array<MappedLocation>,
	location: undefined | { line: number; path: string },
	snippetLevel: SnippetLevel,
	rootDirectory: string,
): Array<string> {
	if (snippetLevel === "none") {
		return [];
	}

	const [loc] = mappedLocations;
	if (loc !== undefined) {
		return getMappedSnippets(loc, snippetLevel, rootDirectory);
	}

	if (location !== undefined) {
		return getFallbackSnippet(location);
	}

	return [];
}

// The expectation detail under a failure header: a snapshot diff, an
// expected/received pair, or the raw message when neither was parsed out.
function buildFailureDetail(parsed: ReturnType<typeof parseErrorMessage>): Array<string> {
	if (parsed.snapshotDiff !== undefined) {
		return [parsed.snapshotDiff];
	}

	if (parsed.expected !== undefined && parsed.received !== undefined) {
		return [`Expected: ${parsed.expected}`, `Received: ${parsed.received}`];
	}

	return [parsed.message];
}

// One failure message: the ` FAIL <file>:<line> > <test>` header, the
// expectation detail (snapshot diff, expected/received pair, or the raw
// message), the source snippets, and a trailing blank line.
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
	);

	const snippets = getFailureSnippets(
		mappedLocations,
		location,
		snippetLevel,
		agentOptions.rootDir,
	);
	for (const snippet of snippets) {
		lines.push(snippet);
	}

	lines.push("");
	return lines;
}

function formatAgentFailure(
	test: TestCaseResult,
	filePath: string,
	options: AgentOptions,
	snippetLevel: SnippetLevel,
): string {
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

function formatFailures(
	result: JestResult,
	totalFailures: number,
	options: AgentOptions,
): Array<string> {
	const lines: Array<string> = [];
	const failures = collectFailedTests(result, options.sourceMapper);
	const snippetLevel = getSnippetLevel(totalFailures);

	for (const [index, { filePath, test }] of failures.entries()) {
		if (index >= options.maxFailures) {
			lines.push(`... ${result.numFailedTests - index} more failures omitted`, "");
			break;
		}

		lines.push(formatAgentFailure(test, filePath, options, snippetLevel));
	}

	return lines;
}

function formatAgentProjectHeader(
	displayName: string,
	result: JestResult,
	options: AgentOptions,
): Array<string> {
	const execErrors = result.testResults.filter(hasExecError);
	const hasFailures = result.numFailedTests > 0 || execErrors.length > 0;

	const fileParts = formatSummaryParts(countFileBuckets(result), PLAIN_STYLES);
	const lines = [`▶ ${displayName}  ${fileParts.join(" | ")} (${result.numTotalTests} tests)`];

	if (hasFailures) {
		lines.push(...formatFileHeaders(result, options));
	}

	return lines;
}

function addCounts(running: SummaryCounts, next: SummaryCounts): void {
	running.failed += next.failed;
	running.passed += next.passed;
	running.skipped += next.skipped;
}

function collectMultiProjectStats(projects: Array<AgentProjectEntry>): AgentProjectStats {
	const stats: AgentProjectStats = {
		allExecErrors: [],
		files: { failed: 0, passed: 0, skipped: 0 },
		tests: { counts: { failed: 0, passed: 0, skipped: 0 }, total: 0 },
	};

	for (const { result } of projects) {
		const tests = countTestBuckets(result);
		addCounts(stats.files, countFileBuckets(result));
		addCounts(stats.tests.counts, tests.counts);
		stats.tests.total += tests.total;
		stats.allExecErrors.push(...result.testResults.filter(hasExecError));
	}

	return stats;
}

function formatMultiProjectFailures(
	projects: Array<AgentProjectEntry>,
	stats: AgentProjectStats,
	options: AgentOptions,
): Array<string> {
	const totalFailures = stats.tests.counts.failed + stats.allExecErrors.length;
	const lines: Array<string> = [
		"",
		`${"⎯".repeat(3)} Failed Tests ${totalFailures} ${"⎯".repeat(3)}`,
		"",
	];

	for (const { result } of projects) {
		if (result.numFailedTests > 0) {
			lines.push(...formatFailures(result, totalFailures, options));
		}
	}

	for (const file of stats.allExecErrors) {
		lines.push(...formatExecError(file, options));
	}

	const hints = formatAgentLogHints(options);
	if (hints !== "") {
		lines.push(hints);
	}

	return lines;
}

function formatMultiProjectSummary(stats: AgentProjectStats, options: AgentOptions): Array<string> {
	const lines: Array<string> = [
		formatTestFilesLine(stats.files, PLAIN_STYLES),
		formatTestsLine(stats.tests, PLAIN_STYLES),
	];

	if (options.typeErrorCount !== undefined) {
		lines.push(formatTypeErrorsLine(options.typeErrorCount, PLAIN_STYLES));
	}

	if (options.bail !== undefined) {
		lines.push(formatBailLine(options.bail, PLAIN_STYLES));
	}

	return lines;
}
