import { getSourceSnippet, type SourceMapper } from "../source-mapper/index.ts";
import { execErrorReason, hasExecError } from "../types/exec-error-file.ts";
import type { ExecErrorTestFileResult, JestResult } from "../types/jest-result-types.ts";
import { formatFailures, type SourceSnippetReader } from "./agent-failures.ts";
import { cleanExecErrorMessage, getExecErrorHint } from "./failure-message.ts";
import { resolveDisplayPath, withPackageRoot } from "./shared.ts";
import type { AffectedSummary, BailSummary } from "./shared.ts";
import { createStyles } from "./styles.ts";
import {
	countFileBuckets,
	countTestBuckets,
	formatAffectedLine,
	formatBailLine,
	formatSummaryParts,
	formatTestFilesLine,
	formatTestsLine,
	formatTypeErrorsLine,
	type SummaryCounts,
	type TestRowCounts,
} from "./summary.ts";

/**
 * Options of the agent formatter.
 */
export interface AgentOptions {
	/** Partial Run only; see {@link AffectedSummary}. */
	affected?: AffectedSummary | undefined;
	/** Set when `--bail` cut the run short; see {@link BailSummary}. */
	bail?: BailSummary | undefined;
	/**
	 * Path of the written Roblox game log, named in the log hints.
	 */
	gameOutput?: string | undefined;
	/**
	 * Size in bytes of the game log, shown beside its path.
	 */
	gameOutputSize?: number | undefined;
	/**
	 * Reads the source lines a snippet shows; defaults to the file system
	 * reader.
	 */
	getSourceSnippet?: SourceSnippetReader;
	/**
	 * Most failures to render; the rest collapse into one omitted line.
	 */
	maxFailures: number;
	/**
	 * Path of the written full Jest output, named in the log hints.
	 */
	outputFile?: string | undefined;
	/**
	 * Size in bytes of the Jest output, shown beside its path.
	 */
	outputFileSize?: number | undefined;
	/**
	 * Directory that failure paths are shown relative to.
	 */
	rootDir: string;
	/**
	 * Maps Luau paths and locations back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Type errors found; adds a summary row when set.
	 */
	typeErrorCount?: number | undefined;
}

type ResolvedAgentOptions = AgentOptions & { getSourceSnippet: SourceSnippetReader };

interface AgentProjectEntry {
	displayName: string;
	result: JestResult;
	rootDir?: string | undefined;
}

interface AgentProjectStats {
	allExecErrors: Array<ExecErrorTestFileResult>;
	files: SummaryCounts;
	tests: TestRowCounts;
}

// This formatter emits plain text only, so the shared summary rows render
// through the no-op palette rather than growing a plain-text twin.
const PLAIN_STYLES = createStyles(false);

/**
 * Render a run as compact plain text for an agent: failures, then the summary.
 * @param result - Run result.
 * @param agentOptions - Formatter options.
 * @returns The rendered output.
 */
export function formatAgent(result: JestResult, agentOptions: AgentOptions): string {
	const options = resolveAgentOptions(agentOptions);
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
			...formatFailures({ options, result, totalFailures: result.numFailedTests }),
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

/**
 * Render several projects' results as one compact plain-text report.
 * @param projects - Each project's name and result.
 * @param agentOptions - Formatter options.
 * @returns The rendered output.
 */
export function formatAgentMultiProject(
	projects: Array<AgentProjectEntry>,
	agentOptions: AgentOptions,
): string {
	const options = resolveAgentOptions(agentOptions);
	const lines: Array<string> = [];

	for (const project of projects) {
		lines.push(...formatAgentProjectHeader({ ...project, options }));
	}

	const stats = collectMultiProjectStats(projects);
	const totalFailures = stats.tests.counts.failed + stats.allExecErrors.length;

	if (totalFailures > 0) {
		lines.push(...formatMultiProjectFailures({ options, projects, stats }));
	}

	lines.push(...formatMultiProjectSummary(stats, options));

	return lines.join("\n");
}

function resolveAgentOptions(options: AgentOptions): ResolvedAgentOptions {
	return { getSourceSnippet, ...options };
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

function formatFileHeaderExecError(
	file: JestResult["testResults"][number],
	options: AgentOptions,
): Array<string> {
	const relativePath = resolveDisplayPath(file.testFilePath, options);

	return [` ❯ ${relativePath} (suite ${execErrorReason(file)})`];
}

function formatFileHeaderFailures(
	file: JestResult["testResults"][number],
	options: AgentOptions,
): Array<string> {
	const lines: Array<string> = [];
	const relativePath = resolveDisplayPath(file.testFilePath, options);
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
	const relativePath = resolveDisplayPath(file.testFilePath, options);

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

function formatAgentProjectHeader({
	displayName,
	options,
	result,
}: AgentProjectEntry & { options: AgentOptions }): Array<string> {
	const fileParts = formatSummaryParts(countFileBuckets(result), PLAIN_STYLES);
	return [
		`▶ ${displayName}  ${fileParts.join(" | ")} (${result.numTotalTests} tests)`,
		...formatFileHeaders(result, options),
	];
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

function formatMultiProjectFailures({
	options,
	projects,
	stats,
}: {
	options: ResolvedAgentOptions;
	projects: Array<AgentProjectEntry>;
	stats: AgentProjectStats;
}): Array<string> {
	const totalFailures = stats.tests.counts.failed + stats.allExecErrors.length;
	const lines: Array<string> = [
		"",
		`${"⎯".repeat(3)} Failed Tests ${totalFailures} ${"⎯".repeat(3)}`,
		"",
	];

	for (const { result, rootDir } of projects) {
		lines.push(
			...formatFailures({
				options: withPackageRoot(options, rootDir),
				result,
				totalFailures,
			}),
		);
	}

	for (const { result, rootDir } of projects) {
		for (const file of result.testResults) {
			if (hasExecError(file)) {
				lines.push(...formatExecError(file, withPackageRoot(options, rootDir)));
			}
		}
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
		...(options.affected === undefined
			? []
			: [formatAffectedLine(options.affected, PLAIN_STYLES)]),
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
