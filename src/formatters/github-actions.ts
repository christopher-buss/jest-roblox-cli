import process from "node:process";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result.ts";
import { hasExecError } from "../types/jest-result.ts";

const SEPARATOR = " · ";

export interface GitHubAnnotation {
	col?: number;
	file: string;
	line?: number;
	message: string;
	title?: string;
}

export interface GitHubActionsOptions {
	repository?: string;
	serverUrl?: string;
	sha?: string;
	sourceMapper?: SourceMapper;
	workspace?: string;
}

export interface GitHubActionsFormatterOptions {
	/**
	 * Whether to emit `::error` workflow commands for test failures.
	 *
	 * @default true
	 */
	displayAnnotations?: boolean;
	/**
	 * Configuration for the GitHub Actions Job Summary.
	 *
	 * When enabled, a markdown summary of test results is written to the path
	 * specified by `outputPath`.
	 */
	jobSummary?: Partial<JobSummaryOptions>;
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
		commitHash?: string;
		/**
		 * The GitHub repository in `owner/repo` format.
		 *
		 * @default process.env.GITHUB_REPOSITORY
		 */
		repository?: string;
		/**
		 * The absolute path to the root of the repository on disk.
		 *
		 * Used to compute relative file paths for the permalink URLs.
		 *
		 * @default process.env.GITHUB_WORKSPACE
		 */
		workspacePath?: string;
	};
	/**
	 * File path to write the summary to.
	 *
	 * @default process.env.GITHUB_STEP_SUMMARY
	 */
	outputPath: string | undefined;
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
			collectExecErrorAnnotation(annotations, file, options);
			continue;
		}

		collectTestFailureAnnotations(annotations, file, options);
	}

	return annotations;
}

export function formatAnnotations(result: JestResult, options: GitHubActionsOptions): string {
	const annotations = collectAnnotations(result, options);

	if (annotations.length === 0) {
		return "";
	}

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
				title: "Test suite failed to run",
			});
			continue;
		}

		for (const test of file.testResults) {
			if (test.status !== "failed") {
				continue;
			}

			failures.push({
				file: makeRelative(file.testFilePath, options.workspace),
				title: test.fullName,
			});
		}
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

export function resolveGitHubActionsOptions(
	userOptions: GitHubActionsFormatterOptions,
	sourceMapper: SourceMapper | undefined,
	environment: Record<string, string | undefined> = process.env as Record<
		string,
		string | undefined
	>,
): GitHubActionsOptions {
	return {
		repository:
			userOptions.jobSummary?.fileLinks?.repository ?? environment["GITHUB_REPOSITORY"],
		serverUrl: environment["GITHUB_SERVER_URL"],
		sha: userOptions.jobSummary?.fileLinks?.commitHash ?? environment["GITHUB_SHA"],
		sourceMapper,
		workspace:
			userOptions.jobSummary?.fileLinks?.workspacePath ?? environment["GITHUB_WORKSPACE"],
	};
}

function makeRelative(filePath: string, workspace: string | undefined): string {
	if (workspace === undefined) {
		return filePath;
	}

	const normalized = filePath.replace(/\\/g, "/");
	const normalizedWorkspace = workspace.replace(/\\/g, "/").replace(/\/$/, "");

	if (normalized.startsWith(`${normalizedWorkspace}/`)) {
		return normalized.slice(normalizedWorkspace.length + 1);
	}

	return filePath;
}

function collectExecErrorAnnotation(
	annotations: Array<GitHubAnnotation>,
	file: JestResult["testResults"][number],
	options: GitHubActionsOptions,
): void {
	annotations.push({
		file: makeRelative(file.testFilePath, options.workspace),
		// hasExecError guarantees failureMessage is defined
		// eslint-disable-next-line ts/no-non-null-assertion -- hasExecError checked by caller
		message: file.failureMessage!,
		title: "Test suite failed to run",
	});
}

function collectTestFailureAnnotations(
	annotations: Array<GitHubAnnotation>,
	file: JestResult["testResults"][number],
	options: GitHubActionsOptions,
): void {
	for (const test of file.testResults) {
		if (test.status !== "failed") {
			continue;
		}

		const firstFailure = test.failureMessages[0] ?? "";
		let annotationFile = file.testFilePath;
		let line: number | undefined;
		let column: number | undefined;

		if (options.sourceMapper !== undefined && firstFailure !== "") {
			const mapped = options.sourceMapper.mapFailureWithLocations(firstFailure);
			const location = mapped.locations[0];

			if (location?.tsPath !== undefined) {
				annotationFile = location.tsPath;
				line = location.tsLine;
				column = location.tsColumn;
			} else if (location !== undefined) {
				annotationFile = location.luauPath;
				line = location.luauLine;
			}
		}

		annotations.push({
			col: column,
			file: makeRelative(annotationFile, options.workspace),
			line,
			message: firstFailure,
			title: test.fullName,
		});
	}
}

function noun(count: number, singular: string, plural: string): string {
	return count === 1 ? singular : plural;
}

function renderStats(result: JestResult): string {
	const failedFiles = result.testResults.filter(
		(file) => file.numFailingTests > 0 || hasExecError(file),
	).length;
	const passedFiles = result.testResults.filter(
		(file) => file.numFailingTests === 0 && !hasExecError(file),
	).length;
	const totalFiles = failedFiles + passedFiles;

	const fileInfo: Array<string> = [];

	if (failedFiles > 0) {
		fileInfo.push(`❌ **${String(failedFiles)} ${noun(failedFiles, "failure", "failures")}**`);
	}

	if (passedFiles > 0) {
		fileInfo.push(`✅ **${String(passedFiles)} ${noun(passedFiles, "pass", "passes")}**`);
	}

	fileInfo.push(`${String(totalFiles)} total`);

	const testInfo: Array<string> = [];

	if (result.numFailedTests > 0) {
		testInfo.push(
			`❌ **${String(result.numFailedTests)} ${noun(result.numFailedTests, "failure", "failures")}**`,
		);
	}

	if (result.numPassedTests > 0) {
		testInfo.push(
			`✅ **${String(result.numPassedTests)} ${noun(result.numPassedTests, "pass", "passes")}**`,
		);
	}

	// Excludes pending/todo — those appear in the "Other" row
	const primaryTotal = result.numFailedTests + result.numPassedTests;
	testInfo.push(`${String(primaryTotal)} total`);

	let output = "### Summary\n\n";
	output += `- **Test Files**: ${fileInfo.join(SEPARATOR)}\n`;
	output += `- **Test Results**: ${testInfo.join(SEPARATOR)}\n`;

	const otherInfo: Array<string> = [];

	if (result.numPendingTests > 0) {
		otherInfo.push(
			`${String(result.numPendingTests)} ${noun(result.numPendingTests, "skip", "skips")}`,
		);
	}

	if (result.numTodoTests !== undefined && result.numTodoTests > 0) {
		otherInfo.push(
			`${String(result.numTodoTests)} ${noun(result.numTodoTests, "todo", "todos")}`,
		);
	}

	if (otherInfo.length > 0) {
		const otherTotal = result.numPendingTests + (result.numTodoTests ?? 0);
		otherInfo.push(`${String(otherTotal)} total`);
		output += `- **Other**: ${otherInfo.join(SEPARATOR)}\n`;
	}

	return output;
}

function createFileLink(options: GitHubActionsOptions): (filePath: string) => string | undefined {
	const { repository, serverUrl, sha } = options;

	if (serverUrl === undefined || repository === undefined || sha === undefined) {
		return (_filePath: string) => {
			// No file links when env vars are missing
		};
	}

	return (filePath) => `${serverUrl}/${repository}/blob/${sha}/${filePath}`;
}
