import process from "node:process";

import type { GitHubActionsFormatterOptions } from "../config/formatter-selection.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import { plural } from "../terminal/plural.ts";
import { execErrorTitle, hasExecError } from "../types/exec-error-file.ts";
import type { ExecErrorTestFileResult, JestResult } from "../types/jest-result-types.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import { countFileBuckets, locateFailure } from "./failure-model.ts";
import { makeRelative } from "./shared.ts";

const SEPARATOR = " · ";

/**
 * Inputs of `resolveGitHubActionsOptions`.
 */
export interface ResolveGitHubActionsOptions {
	/**
	 * Environment the `GITHUB_*` defaults are read from; defaults to
	 * `process.env`.
	 */
	environment?: Record<string, string | undefined>;
	/**
	 * Maps Luau failure locations back to TypeScript source.
	 */
	sourceMapper: SourceMapper | undefined;
	/**
	 * Formatter options from the config, which win over the environment.
	 */
	userOptions: GitHubActionsFormatterOptions;
}

/** The GitHub Actions formatter's settings, every default applied. */
export interface ResolvedGitHubActions {
	/** Whether to write `::error` workflow commands. */
	annotations: boolean;
	/** GitHub context the annotations and the summary render with. */
	context: GitHubActionsOptions;
	/** Where to append the Job Summary; undefined writes none. */
	jobSummaryPath: string | undefined;
}

interface GitHubActionsOptions {
	repository?: string | undefined;
	serverUrl?: string | undefined;
	sha?: string | undefined;
	sourceMapper?: SourceMapper | undefined;
	workspace?: PosixRoot | undefined;
}

interface GitHubAnnotation {
	col?: number | undefined;
	file: string;
	line?: number | undefined;
	message: string;
	title: string;
}

/**
 * Render every failure as an `::error` workflow command.
 * @param result - Run result.
 * @param options - Resolved GitHub context and source mapper.
 * @returns The commands joined by newlines.
 */
export function formatAnnotations(result: JestResult, options: GitHubActionsOptions): string {
	const annotations = collectAnnotations(result, options);
	return annotations.map(formatAnnotation).join("\n");
}

/**
 * Render the Job Summary markdown: counts, then linked failures.
 * @param result - Run result.
 * @param options - Resolved GitHub context and source mapper.
 * @returns The markdown.
 */
export function formatJobSummary(result: JestResult, options: GitHubActionsOptions): string {
	const fileLink = createFileLink(options);
	const lines: Array<string> = ["## Test Results\n", renderStats(result)];

	const failures: Array<{ file: string; title: string }> = [];

	for (const file of result.testResults) {
		if (hasExecError(file)) {
			failures.push({
				file: relativeToWorkspace(file.testFilePath, options.workspace),
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

/**
 * Merge the formatter options over their `GITHUB_*` environment defaults.
 * @param options - Formatter options, environment and source mapper.
 * @returns What to write, and the GitHub context to write it with.
 */
export function resolveGitHubActions(options: ResolveGitHubActionsOptions): ResolvedGitHubActions {
	const { environment = process.env, userOptions } = options;
	const { jobSummary } = userOptions;
	return {
		annotations: userOptions.displayAnnotations !== false,
		context: resolveGitHubActionsOptions(options),
		jobSummaryPath:
			jobSummary?.enabled === false
				? undefined
				: (jobSummary?.outputPath ?? environment["GITHUB_STEP_SUMMARY"]),
	};
}

function escapeData(value: string): string {
	return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
	return value
		.replace(/%/g, "%25")
		.replace(/\r/g, "%0D")
		.replace(/\n/g, "%0A")
		.replace(/:/g, "%3A")
		.replace(/,/g, "%2C");
}

function formatAnnotation(annotation: GitHubAnnotation): string {
	const properties: Array<string> = [`file=${escapeProperty(annotation.file)}`];

	if (annotation.line !== undefined) {
		properties.push(`line=${String(annotation.line)}`);
	}

	if (annotation.col !== undefined) {
		properties.push(`col=${String(annotation.col)}`);
	}

	properties.push(`title=${escapeProperty(annotation.title)}`);

	return `::error ${properties.join(",")}::${escapeData(annotation.message)}`;
}

function relativeToWorkspace(filePath: string, workspace: PosixRoot | undefined): string {
	if (workspace === undefined) {
		return filePath;
	}

	return makeRelative(filePath, workspace);
}

function collectExecErrorAnnotation({
	file,
	options,
}: {
	file: ExecErrorTestFileResult;
	options: GitHubActionsOptions;
}): GitHubAnnotation {
	return {
		file: relativeToWorkspace(file.testFilePath, options.workspace),
		message: file.failureMessage,
		title: execErrorTitle(file),
	};
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
		const { primary } = locateFailure(firstFailure, options.sourceMapper);

		annotations.push({
			col: primary?.column,
			file: relativeToWorkspace(primary?.path ?? file.testFilePath, options.workspace),
			line: primary?.line,
			message: firstFailure,
			title: test.fullName,
		});
	}

	return annotations;
}

function collectAnnotations(
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
			file: relativeToWorkspace(file.testFilePath, options.workspace),
			title: test.fullName,
		});
	}

	return failures;
}

function renderFileCounts(result: JestResult): Array<string> {
	const { failed, passed, skipped } = countFileBuckets(result);
	const fileInfo: Array<string> = [];

	if (failed > 0) {
		fileInfo.push(`❌ **${String(failed)} ${plural(failed, "failure")}**`);
	}

	if (passed > 0) {
		fileInfo.push(`✅ **${String(passed)} ${plural(passed, ["pass", "passes"])}**`);
	}

	if (skipped > 0) {
		fileInfo.push(`${String(skipped)} ${plural(skipped, "skip")}`);
	}

	fileInfo.push(`${String(failed + passed + skipped)} total`);
	return fileInfo;
}

function renderTestCounts(result: JestResult): Array<string> {
	const testInfo: Array<string> = [];

	if (result.numFailedTests > 0) {
		testInfo.push(
			`❌ **${String(result.numFailedTests)} ${plural(result.numFailedTests, "failure")}**`,
		);
	}

	if (result.numPassedTests > 0) {
		testInfo.push(
			`✅ **${String(result.numPassedTests)} ${plural(result.numPassedTests, ["pass", "passes"])}**`,
		);
	}

	const primaryTotal = result.numFailedTests + result.numPassedTests;
	testInfo.push(`${String(primaryTotal)} total`);
	return testInfo;
}

function renderOtherCounts(result: JestResult): Array<string> {
	const otherInfo: Array<string> = [];

	if (result.numPendingTests > 0) {
		otherInfo.push(
			`${String(result.numPendingTests)} ${plural(result.numPendingTests, "skip")}`,
		);
	}

	if (result.numTodoTests !== undefined && result.numTodoTests > 0) {
		otherInfo.push(`${String(result.numTodoTests)} ${plural(result.numTodoTests, "todo")}`);
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

function resolveGitHubActionsOptions({
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
		workspace: workspacePath === undefined ? undefined : toPosixRoot(workspacePath),
	};
}
