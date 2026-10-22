import process from "node:process";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { ExecErrorTestFileResult, JestResult } from "../types/jest-result.ts";
import { execErrorTitle, hasExecError } from "../types/jest-result.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import {
	normalizeWindowsPath,
	relativeToRoot,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";

const SEPARATOR = " · ";

export interface GitHubActionsFormatterOptions {
	/**
	 * Whether to emit `::error` workflow commands for test failures.
	 *
	 * @default true
	 */
	displayAnnotations?: boolean | undefined;
	/**
	 * Configuration for the GitHub Actions Job Summary.
	 *
	 * When enabled, a markdown summary of test results is written to the path
	 * specified by `outputPath`.
	 */
	jobSummary?: Partial<JobSummaryOptions> | undefined;
}

export interface ResolveGitHubActionsOptions {
	environment?: Record<string, string | undefined>;
	sourceMapper: SourceMapper | undefined;
	userOptions: GitHubActionsFormatterOptions;
}

interface JobSummaryOptions {
	/**
	 * Whether to generate the summary.
	 *
	 * @default true
	 */
	enabled: boolean;
	/**
	 * Configuration for generating permalink URLs to source files in the
	 * GitHub repository.
	 *
	 * When all three values are available (either from this config or the
	 * defaults picked from environment variables), test names in the summary
	 * will link to the relevant source lines.
	 */
	fileLinks: {
		/**
		 * The commit SHA to use in permalink URLs.
		 *
		 * @default process.env.GITHUB_SHA
		 */
		commitHash?: string | undefined;
		/**
		 * The GitHub repository in `owner/repo` format.
		 *
		 * @default process.env.GITHUB_REPOSITORY
		 */
		repository?: string | undefined;
		/**
		 * The absolute path to the root of the repository on disk.
		 *
		 * Used to compute relative file paths for the permalink URLs.
		 *
		 * @default process.env.GITHUB_WORKSPACE
		 */
		workspacePath?: string | undefined;
	};
	/**
	 * File path to write the summary to.
	 *
	 * @default process.env.GITHUB_STEP_SUMMARY
	 */
	outputPath: string | undefined;
}

interface GitHubAnnotation {
	col?: number | undefined;
	file: string;
	line?: number | undefined;
	message: string;
	title?: string | undefined;
}

interface GitHubActionsOptions {
	repository?: string | undefined;
	serverUrl?: string | undefined;
	sha?: string | undefined;
	sourceMapper?: SourceMapper | undefined;
	workspace?: PosixRoot | undefined;
}

export function escapeData(value: string): string {
	return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(value: string): string {
	return value
		.replace(/%/g, "%25")
		.replace(/\r/g, "%0D")
		.replace(/\n/g, "%0A")
		.replace(/:/g, "%3A")
		.replace(/,/g, "%2C");
}

export function formatAnnotation(annotation: GitHubAnnotation): string {
	const properties: Array<string> = [`file=${escapeProperty(annotation.file)}`];

	if (annotation.line !== undefined) {
		properties.push(`line=${String(annotation.line)}`);
	}

	if (annotation.col !== undefined) {
		properties.push(`col=${String(annotation.col)}`);
	}

	if (annotation.title !== undefined) {
		properties.push(`title=${escapeProperty(annotation.title)}`);
	}

	return `::error ${properties.join(",")}::${escapeData(annotation.message)}`;
}

export function collectAnnotations(
	result: JestResult,
	options: GitHubActionsOptions,
): Array<GitHubAnnotation> {
	const annotations: Array<GitHubAnnotation> = [];

	for (const file of result.testResults) {
		if (hasExecError(file)) {
			annotations.push(collectExecErrorAnnotation({ file, options }));
			continue;
		}

		annotations.push(...collectTestFailureAnnotations({ file, options }));
	}

	return annotations;
}

export function formatAnnotations(result: JestResult, options: GitHubActionsOptions): string {
	const annotations = collectAnnotations(result, options);
	return annotations.map(formatAnnotation).join("\n");
}

export function formatJobSummary(result: JestResult, options: GitHubActionsOptions): string {
	const fileLink = createFileLink(options);
	const lines: Array<string> = ["## Test Results\n", renderStats(result)];

	// Failures
	const failures: Array<{ file: string; title: string }> = [];

	for (const file of result.testResults) {
		if (hasExecError(file)) {
			failures.push({
				file: makeRelative(file.testFilePath, options.workspace),
				title: execErrorTitle(file),
			});
			continue;
		}

		failures.push(...collectFileFailures(file, options));
	}

	if (failures.length > 0) {
		lines.push("### Failures\n");

		for (const failure of failures) {
			const link = fileLink(failure.file);
			const fileRef = link !== undefined ? `[${failure.file}](${link})` : failure.file;
			lines.push(`- **${failure.title}** in ${fileRef}`);
		}

		lines.push("");
	}

	return lines.join("\n");
}

export function resolveGitHubActionsOptions({
	environment = process.env,
	sourceMapper,
	userOptions,
}: ResolveGitHubActionsOptions): GitHubActionsOptions {
	const workspacePath =
		userOptions.jobSummary?.fileLinks?.workspacePath ?? environment["GITHUB_WORKSPACE"];
	return {
		repository:
			userOptions.jobSummary?.fileLinks?.repository ?? environment["GITHUB_REPOSITORY"],
		serverUrl: environment["GITHUB_SERVER_URL"],
		sha: userOptions.jobSummary?.fileLinks?.commitHash ?? environment["GITHUB_SHA"],
		sourceMapper,
		// Canonical once here rather than per annotation: the value is fixed for
		// the whole run, and every reader of it wants the same spelling.
		workspace: workspacePath === undefined ? undefined : toPosixRoot(workspacePath),
	};
}

function makeRelative(filePath: string, workspace: PosixRoot | undefined): string {
	if (workspace === undefined) {
		return filePath;
	}

	return relativeToRoot(workspace, normalizeWindowsPath(filePath)) ?? filePath;
}

function collectExecErrorAnnotation({
	file,
	options,
}: {
	file: ExecErrorTestFileResult;
	options: GitHubActionsOptions;
}): GitHubAnnotation {
	return {
		file: makeRelative(file.testFilePath, options.workspace),
		message: file.failureMessage,
		title: execErrorTitle(file),
	};
}

function locateFailure(
	message: string,
	sourceMapper: SourceMapper | undefined,
): undefined | { column: number | undefined; file: string; line: number | undefined } {
	if (message === "" || sourceMapper === undefined) {
		return undefined;
	}

	const [location] = sourceMapper.mapFailureWithLocations(message).locations;
	if (location?.tsPath !== undefined) {
		return { column: location.tsColumn, file: location.tsPath, line: location.tsLine };
	}

	if (location !== undefined) {
		return { column: undefined, file: location.luauPath, line: location.luauLine };
	}

	return undefined;
}

function collectTestFailureAnnotations({
	file,
	options,
}: {
	file: JestResult["testResults"][number];
	options: GitHubActionsOptions;
}): Array<GitHubAnnotation> {
	const annotations: Array<GitHubAnnotation> = [];
	for (const test of file.testResults) {
		if (test.status !== "failed") {
			continue;
		}

		const firstFailure = test.failureMessages[0] ?? "";
		const located = locateFailure(firstFailure, options.sourceMapper);

		annotations.push({
			col: located?.column,
			file: makeRelative(located?.file ?? file.testFilePath, options.workspace),
			line: located?.line,
			message: firstFailure,
			title: test.fullName,
		});
	}

	return annotations;
}

function collectFileFailures(
	file: JestResult["testResults"][number],
	options: GitHubActionsOptions,
): Array<{ file: string; title: string }> {
	const failures: Array<{ file: string; title: string }> = [];
	for (const test of file.testResults) {
		if (test.status !== "failed") {
			continue;
		}

		failures.push({
			file: makeRelative(file.testFilePath, options.workspace),
			title: test.fullName,
		});
	}

	return failures;
}

function noun({
	count,
	plural,
	singular,
}: {
	count: number;
	plural: string;
	singular: string;
}): string {
	return count === 1 ? singular : plural;
}

// File-level pass/fail counts plus their total. A file with an exec error
// counts as failed even when it reported no failing tests.
function renderFileCounts(result: JestResult): Array<string> {
	const failedFiles = result.testResults.filter(
		(file) => file.numFailingTests > 0 || hasExecError(file),
	).length;
	const passedFiles = result.testResults.filter(
		(file) => file.numFailingTests === 0 && !hasExecError(file),
	).length;

	const fileInfo: Array<string> = [];

	if (failedFiles > 0) {
		fileInfo.push(
			`❌ **${String(failedFiles)} ${noun({ count: failedFiles, plural: "failures", singular: "failure" })}**`,
		);
	}

	if (passedFiles > 0) {
		fileInfo.push(
			`✅ **${String(passedFiles)} ${noun({ count: passedFiles, plural: "passes", singular: "pass" })}**`,
		);
	}

	fileInfo.push(`${String(failedFiles + passedFiles)} total`);
	return fileInfo;
}

function renderTestCounts(result: JestResult): Array<string> {
	const testInfo: Array<string> = [];

	if (result.numFailedTests > 0) {
		testInfo.push(
			`❌ **${String(result.numFailedTests)} ${noun({ count: result.numFailedTests, plural: "failures", singular: "failure" })}**`,
		);
	}

	if (result.numPassedTests > 0) {
		testInfo.push(
			`✅ **${String(result.numPassedTests)} ${noun({ count: result.numPassedTests, plural: "passes", singular: "pass" })}**`,
		);
	}

	// Excludes pending/todo — those appear in the "Other" row
	const primaryTotal = result.numFailedTests + result.numPassedTests;
	testInfo.push(`${String(primaryTotal)} total`);
	return testInfo;
}

// Pending/todo counts plus their total, or empty when neither is present — in
// which case the caller omits the whole row.
function renderOtherCounts(result: JestResult): Array<string> {
	const otherInfo: Array<string> = [];

	if (result.numPendingTests > 0) {
		otherInfo.push(
			`${String(result.numPendingTests)} ${noun({ count: result.numPendingTests, plural: "skips", singular: "skip" })}`,
		);
	}

	if (result.numTodoTests !== undefined && result.numTodoTests > 0) {
		otherInfo.push(
			`${String(result.numTodoTests)} ${noun({ count: result.numTodoTests, plural: "todos", singular: "todo" })}`,
		);
	}

	if (otherInfo.length > 0) {
		const otherTotal = result.numPendingTests + (result.numTodoTests ?? 0);
		otherInfo.push(`${String(otherTotal)} total`);
	}

	return otherInfo;
}

function renderStats(result: JestResult): string {
	let output = "### Summary\n\n";
	output += `- **Test Files**: ${renderFileCounts(result).join(SEPARATOR)}\n`;
	output += `- **Test Results**: ${renderTestCounts(result).join(SEPARATOR)}\n`;

	const otherInfo = renderOtherCounts(result);
	if (otherInfo.length > 0) {
		output += `- **Other**: ${otherInfo.join(SEPARATOR)}\n`;
	}

	return output;
}

function createFileLink({
	repository,
	serverUrl,
	sha,
}: GitHubActionsOptions): (filePath: string) => string | undefined {
	if (serverUrl === undefined || repository === undefined || sha === undefined) {
		return () => {
			// No file links when env vars are missing
		};
	}

	return (filePath) => `${serverUrl}/${repository}/blob/${sha}/${filePath}`;
}
