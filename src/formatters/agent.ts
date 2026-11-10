import { getSourceSnippet, type SourceMapper } from "../source-mapper/index.ts";
import { createStyles } from "../terminal/palette.ts";
import { plural } from "../terminal/plural.ts";
import type { BailSummary } from "../types/bail-summary-types.ts";
import { execErrorReason, hasExecError } from "../types/exec-error-file.ts";
import type { ExecErrorTestFileResult, JestResult } from "../types/jest-result-types.ts";
import {
	type AgentFailure,
	collectAgentFailures,
	formatFailures,
	type SourceSnippetReader,
} from "./agent-failures.ts";
import {
	countFileBuckets,
	describeExecError,
	formatFailedTestsHeader,
	formatLogHintLines,
	type SummaryCounts,
} from "./failure-model.ts";
import type { AffectedSummary } from "./shared.ts";
import { resolveDisplayPath, withPackageRoot } from "./shared.ts";
import {
	countTestBuckets,
	formatAffectedLine,
	formatBailLine,
	formatSummaryParts,
	formatTestFilesLine,
	formatTestsLine,
	formatTypeErrorsLine,
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
	 * Reads the source lines a snippet shows; defaults to the file system
	 * reader.
	 */
	getSourceSnippet?: SourceSnippetReader;
	/**
	 * Most failures to render across the run; the rest collapse into one
	 * omitted line.
	 */
	maxFailures: number;
	/**
	 * Path of the written full Jest output, named in the log hints.
	 */
	outputFile?: string | undefined;
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

interface AgentRunStats {
	files: SummaryCounts;
	tests: TestRowCounts;
}

const PLAIN_STYLES = createStyles(false);

/**
 * Render a run as compact plain text for an agent: failures, then the summary.
 * @param result - Run result.
 * @param agentOptions - Formatter options.
 * @returns The rendered output.
 */
export function formatAgent(result: JestResult, agentOptions: AgentOptions): string {
	const options = resolveAgentOptions(agentOptions);
	const projects = [{ result }];

	return [
		...formatFileHeaders(result, options),
		...formatFailureSection(projects, options),
		...formatSummaryRows(collectStats(projects), options),
	].join("\n");
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

	return [
		...projects.flatMap((project) => formatAgentProjectHeader(project, options)),
		...formatFailureSection(projects, options),
		...formatSummaryRows(collectStats(projects), options),
	].join("\n");
}

function resolveAgentOptions(options: AgentOptions): ResolvedAgentOptions {
	return { getSourceSnippet, ...options };
}

function formatFileHeaderFailures(
	file: JestResult["testResults"][number],
	options: AgentOptions,
): Array<string> {
	const relativePath = resolveDisplayPath(file.testFilePath, options);
	const totalTests = file.numFailingTests + file.numPassingTests + file.numPendingTests;
	const lines = [
		` ❯ ${relativePath} (${totalTests} ${plural(totalTests, "test")} | ${file.numFailingTests} failed)`,
	];

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
	return result.testResults.flatMap((file) => {
		if (hasExecError(file)) {
			return [
				` ❯ ${resolveDisplayPath(file.testFilePath, options)} (suite ${execErrorReason(file)})`,
			];
		}

		return file.numFailingTests !== 0 ? formatFileHeaderFailures(file, options) : [];
	});
}

function addCounts(running: SummaryCounts, next: SummaryCounts): void {
	running.failed += next.failed;
	running.passed += next.passed;
	running.skipped += next.skipped;
}

function collectStats(projects: Array<{ result: JestResult }>): AgentRunStats {
	const stats: AgentRunStats = {
		files: { failed: 0, passed: 0, skipped: 0 },
		tests: { counts: { failed: 0, passed: 0, skipped: 0 }, total: 0 },
	};

	for (const { result } of projects) {
		const tests = countTestBuckets(result);
		addCounts(stats.files, countFileBuckets(result));
		addCounts(stats.tests.counts, tests.counts);
		stats.tests.total += tests.total;
	}

	return stats;
}

function formatExecError(file: ExecErrorTestFileResult, options: AgentOptions): Array<string> {
	const block = describeExecError(file);
	const lines = [
		` ${block.badge} ${resolveDisplayPath(file.testFilePath, options)}`,
		block.message,
	];

	if (block.hint !== undefined) {
		lines.push(`Hint: ${block.hint}`);
	}

	lines.push("");
	return lines;
}

function collectFailures(
	projects: Array<{ result: JestResult; rootDir?: string | undefined }>,
	options: ResolvedAgentOptions,
): { execErrors: Array<string>; failures: Array<AgentFailure>; totalFailures: number } {
	const failures: Array<AgentFailure> = [];
	const execErrors: Array<string> = [];
	let totalFailures = 0;

	for (const { result, rootDir } of projects) {
		const projectOptions = withPackageRoot(options, rootDir);
		totalFailures += result.numFailedTests;

		const thrown = result.testResults.filter(hasExecError);
		totalFailures += thrown.length;
		execErrors.push(...thrown.flatMap((file) => formatExecError(file, projectOptions)));

		failures.push(...collectAgentFailures(result, projectOptions));
	}

	return { execErrors, failures, totalFailures };
}

function formatFailureSection(
	projects: Array<{ result: JestResult; rootDir?: string | undefined }>,
	options: ResolvedAgentOptions,
): Array<string> {
	const { execErrors, failures, totalFailures } = collectFailures(projects, options);

	if (totalFailures === 0) {
		return [];
	}

	return [
		"",
		formatFailedTestsHeader(totalFailures, { rule: 3, styles: PLAIN_STYLES }),
		"",
		...formatFailures({ failures, maxFailures: options.maxFailures, totalFailures }),
		...execErrors,
		...formatLogHintLines(options),
	];
}

function formatSummaryRows(stats: AgentRunStats, options: AgentOptions): Array<string> {
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

function formatAgentProjectHeader(
	{ displayName, result }: AgentProjectEntry,
	options: AgentOptions,
): Array<string> {
	const fileParts = formatSummaryParts(countFileBuckets(result), PLAIN_STYLES);
	return [
		`▶ ${displayName}  ${fileParts.join(" | ")} (${result.numTotalTests} tests)`,
		...formatFileHeaders(result, options),
	];
}
