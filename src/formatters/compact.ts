import assert from "node:assert";
import path from "node:path";

import {
	getSourceSnippet,
	type MappedLocation,
	type SourceMapper,
} from "../source-mapper/index.ts";
import { hasExecError, type JestResult, type TestCaseResult } from "../types/jest-result.ts";
import {
	cleanExecErrorMessage,
	getExecErrorHint,
	parseErrorMessage,
	parseSourceLocation,
	resolveDisplayPath,
} from "./formatter.ts";

export interface CompactOptions {
	gameOutput?: string;
	gameOutputSize?: number;
	maxFailures: number;
	outputFile?: string;
	outputFileSize?: number;
	rootDir: string;
	sourceMapper?: SourceMapper;
	typeErrorCount?: number;
}

export interface CompactProjectEntry {
	displayName: string;
	result: JestResult;
}

type SnippetLevel = "both" | "none" | "ts-only";

interface CompactProjectStats {
	allExecErrors: Array<JestResult["testResults"][number]>;
	totalFailed: number;
	totalFailedFiles: number;
	totalPassed: number;
	totalPassedFiles: number;
	totalPending: number;
	totalSkippedFiles: number;
	totalTests: number;
}

export function formatCompact(result: JestResult, options: CompactOptions): string {
	const lines: Array<string> = [];
	const execErrors = result.testResults.filter(hasExecError);
	const hasFailures = result.numFailedTests > 0 || execErrors.length > 0;

	if (hasFailures) {
		lines.push(...formatFileHeaders(result, options), "");

		const totalFailures = result.numFailedTests + execErrors.length;
		lines.push(`${"⎯".repeat(3)} Failed Tests ${totalFailures} ${"⎯".repeat(3)}`, "");

		if (result.numFailedTests > 0) {
			const failureLines = formatFailures(result, result.numFailedTests, options);
			lines.push(...failureLines);
		}

		for (const file of execErrors) {
			lines.push(...formatExecError(file, options));
		}

		const hints = formatCompactLogHints(options);
		if (hints !== "") {
			lines.push(hints);
		}
	}

	lines.push(...formatSummarySection(result, options));

	return lines.join("\n");
}

export function formatCompactMultiProject(
	projects: Array<CompactProjectEntry>,
	options: CompactOptions,
): string {
	const lines: Array<string> = [];

	for (const { displayName, result } of projects) {
		lines.push(...formatCompactProjectHeader(displayName, result, options));
	}

	const stats = collectMultiProjectStats(projects);
	const totalFailures = stats.totalFailed + stats.allExecErrors.length;

	if (totalFailures > 0) {
		lines.push(...formatMultiProjectFailures(projects, stats, options));
	}

	lines.push(...formatMultiProjectSummary(stats, options));

	return lines.join("\n");
}

function formatTypeErrorLabel(count: number): string {
	if (count === 0) {
		return "no errors";
	}

	return `${count} error${count === 1 ? "" : "s"}`;
}

function formatSummarySection(result: JestResult, options: CompactOptions): Array<string> {
	const lines: Array<string> = [];

	const failedFiles = result.testResults.filter(
		(file) => file.numFailingTests > 0 || hasExecError(file),
	).length;
	const passedFiles = result.testResults.filter(
		(file) => file.numFailingTests === 0 && !hasExecError(file),
	).length;
	const totalFiles = failedFiles + passedFiles;

	const fileParts: Array<string> = [];
	if (failedFiles > 0) {
		fileParts.push(`${failedFiles} failed`);
	}

	if (passedFiles > 0) {
		fileParts.push(`${passedFiles} passed`);
	}

	lines.push(` Test Files  ${fileParts.join(" | ")} (${totalFiles})`);

	const testParts: Array<string> = [];

	if (result.numFailedTests > 0) {
		testParts.push(`${result.numFailedTests} failed`);
	}

	if (result.numPassedTests > 0) {
		testParts.push(`${result.numPassedTests} passed`);
	}

	if (result.numPendingTests > 0) {
		testParts.push(`${result.numPendingTests} skipped`);
	}

	const totalTests = result.numTotalTests;
	lines.push(`      Tests  ${testParts.join(" | ")} (${totalTests})`);

	if (options.typeErrorCount !== undefined) {
		const typeLabel = formatTypeErrorLabel(options.typeErrorCount);
		lines.push(`Type Errors  ${typeLabel}`);
	}

	return lines;
}

function makeRelative(filePath: string, rootDirectory: string): string {
	const normalizedPath = filePath.replaceAll("\\", "/");
	const normalizedRoot = rootDirectory.replaceAll("\\", "/");

	if (normalizedPath.startsWith(normalizedRoot)) {
		return path.relative(normalizedRoot, normalizedPath).replaceAll("\\", "/");
	}

	return filePath;
}

function formatFileHeaderExecError(
	file: JestResult["testResults"][number],
	options: CompactOptions,
): Array<string> {
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const relativePath = makeRelative(displayPath, options.rootDir);

	return [` ❯ ${relativePath} (suite failed to run)`];
}

function formatFileHeaderFailures(
	file: JestResult["testResults"][number],
	options: CompactOptions,
): Array<string> {
	const lines: Array<string> = [];
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const relativePath = makeRelative(displayPath, options.rootDir);
	const totalTests = file.numFailingTests + file.numPassingTests + file.numPendingTests;
	const testWord = totalTests === 1 ? "test" : "tests";

	lines.push(` ❯ ${relativePath} (${totalTests} ${testWord} | ${file.numFailingTests} failed)`);

	for (const test of file.testResults) {
		if (test.status === "failed") {
			const duration = test.duration !== undefined ? ` ${String(test.duration)}ms` : "";
			lines.push(`   × ${test.title}${duration}`);
		}
	}

	return lines;
}

function formatFileHeaders(result: JestResult, options: CompactOptions): Array<string> {
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

function formatExecError(
	file: JestResult["testResults"][number],
	options: CompactOptions,
): Array<string> {
	const lines: Array<string> = [];
	const displayPath = resolveDisplayPath(file.testFilePath, options.sourceMapper);
	const relativePath = makeRelative(displayPath, options.rootDir);

	assert(file.failureMessage !== undefined, "exec error files have failureMessage");
	const errorMessage = cleanExecErrorMessage(file.failureMessage);

	lines.push(` FAIL ${relativePath}`, errorMessage);

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

function formatCompactLogHints(options: CompactOptions): string {
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
	if (mappedLocations.length > 0) {
		const loc = mappedLocations[0];
		assert(loc !== undefined, "array with length > 0 has element 0");

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
	loc: MappedLocation,
	snippetLevel: SnippetLevel,
	rootDirectory: string,
): Array<string> {
	assert(loc.tsPath !== undefined && loc.tsLine !== undefined, "caller checked ts fields");
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
		return getTsSnippets(loc, snippetLevel, rootDirectory);
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

	if (mappedLocations.length > 0) {
		const loc = mappedLocations[0];
		assert(loc !== undefined, "array with length > 0 has element 0");

		return getMappedSnippets(loc, snippetLevel, rootDirectory);
	}

	if (location !== undefined) {
		return getFallbackSnippet(location);
	}

	return [];
}

function formatCompactFailure(
	test: TestCaseResult,
	filePath: string,
	options: CompactOptions,
	snippetLevel: SnippetLevel,
): string {
	const lines: Array<string> = [];

	for (const originalMessage of test.failureMessages) {
		let mappedLocations: Array<MappedLocation> = [];
		let message = originalMessage;

		if (options.sourceMapper !== undefined) {
			({ locations: mappedLocations, message } =
				options.sourceMapper.mapFailureWithLocations(originalMessage));
		}

		const parsed = parseErrorMessage(originalMessage);
		const location = findFailureLocation(mappedLocations, message);
		const relativePath = makeRelative(location?.path ?? filePath, options.rootDir);
		const lineInfo = location?.line !== undefined ? `:${location.line}` : "";
		const ancestors =
			test.ancestorTitles.length > 0 ? ` > ${test.ancestorTitles.join(" > ")}` : "";

		lines.push(` FAIL ${relativePath}${lineInfo}${ancestors} > ${test.title}`);

		if (parsed.snapshotDiff !== undefined) {
			lines.push(parsed.snapshotDiff);
		} else if (parsed.expected !== undefined && parsed.received !== undefined) {
			lines.push(`Expected: ${parsed.expected}`, `Received: ${parsed.received}`);
		}

		const snippets = getFailureSnippets(
			mappedLocations,
			location,
			snippetLevel,
			options.rootDir,
		);
		for (const snippet of snippets) {
			lines.push(snippet);
		}

		lines.push("");
	}

	return lines.join("\n");
}

function formatFailures(
	result: JestResult,
	totalFailures: number,
	options: CompactOptions,
): Array<string> {
	const lines: Array<string> = [];
	const failures = collectFailedTests(result, options.sourceMapper);
	const snippetLevel = getSnippetLevel(totalFailures);

	for (const [index, { filePath, test }] of failures.entries()) {
		if (index >= options.maxFailures) {
			lines.push(`... ${result.numFailedTests - index} more failures omitted`, "");
			break;
		}

		lines.push(formatCompactFailure(test, filePath, options, snippetLevel));
	}

	return lines;
}

function formatCompactProjectHeader(
	displayName: string,
	result: JestResult,
	options: CompactOptions,
): Array<string> {
	const execErrors = result.testResults.filter(hasExecError);
	const hasFailures = result.numFailedTests > 0 || execErrors.length > 0;

	const failedFiles = result.testResults.filter(
		(file) => file.numFailingTests > 0 || hasExecError(file),
	).length;
	const skippedFiles = result.testResults.filter(
		(file) => file.numFailingTests === 0 && file.numPassingTests === 0 && !hasExecError(file),
	).length;
	const passedFiles = result.testResults.length - failedFiles - skippedFiles;

	const fileParts: Array<string> = [];
	if (passedFiles > 0) {
		fileParts.push(`${passedFiles} passed`);
	}

	if (failedFiles > 0) {
		fileParts.push(`${failedFiles} failed`);
	}

	if (skippedFiles > 0) {
		fileParts.push(`${skippedFiles} skipped`);
	}

	const lines = [`▶ ${displayName}  ${fileParts.join(" | ")} (${result.numTotalTests} tests)`];

	if (hasFailures) {
		lines.push(...formatFileHeaders(result, options));
	}

	return lines;
}

function collectMultiProjectStats(projects: Array<CompactProjectEntry>): CompactProjectStats {
	const stats: CompactProjectStats = {
		allExecErrors: [],
		totalFailed: 0,
		totalFailedFiles: 0,
		totalPassed: 0,
		totalPassedFiles: 0,
		totalPending: 0,
		totalSkippedFiles: 0,
		totalTests: 0,
	};

	for (const { result } of projects) {
		const failedFiles = result.testResults.filter(
			(file) => file.numFailingTests > 0 || hasExecError(file),
		).length;
		const skippedFiles = result.testResults.filter(
			(file) =>
				file.numFailingTests === 0 && file.numPassingTests === 0 && !hasExecError(file),
		).length;

		stats.totalFailed += result.numFailedTests;
		stats.totalPassed += result.numPassedTests;
		stats.totalPending += result.numPendingTests;
		stats.totalTests += result.numTotalTests;
		stats.totalFailedFiles += failedFiles;
		stats.totalSkippedFiles += skippedFiles;
		stats.totalPassedFiles += result.testResults.length - failedFiles - skippedFiles;
		stats.allExecErrors.push(...result.testResults.filter(hasExecError));
	}

	return stats;
}

function formatMultiProjectFailures(
	projects: Array<CompactProjectEntry>,
	stats: CompactProjectStats,
	options: CompactOptions,
): Array<string> {
	const totalFailures = stats.totalFailed + stats.allExecErrors.length;
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

	const hints = formatCompactLogHints(options);
	if (hints !== "") {
		lines.push(hints);
	}

	return lines;
}

function formatMultiProjectSummary(
	stats: CompactProjectStats,
	options: CompactOptions,
): Array<string> {
	const lines: Array<string> = [];

	const fileParts: Array<string> = [];
	if (stats.totalFailedFiles > 0) {
		fileParts.push(`${stats.totalFailedFiles} failed`);
	}

	if (stats.totalPassedFiles > 0) {
		fileParts.push(`${stats.totalPassedFiles} passed`);
	}

	if (stats.totalSkippedFiles > 0) {
		fileParts.push(`${stats.totalSkippedFiles} skipped`);
	}

	const totalFiles = stats.totalFailedFiles + stats.totalPassedFiles + stats.totalSkippedFiles;
	lines.push(` Test Files  ${fileParts.join(" | ")} (${totalFiles})`);

	const testParts: Array<string> = [];
	if (stats.totalFailed > 0) {
		testParts.push(`${stats.totalFailed} failed`);
	}

	if (stats.totalPassed > 0) {
		testParts.push(`${stats.totalPassed} passed`);
	}

	if (stats.totalPending > 0) {
		testParts.push(`${stats.totalPending} skipped`);
	}

	lines.push(`      Tests  ${testParts.join(" | ")} (${stats.totalTests})`);

	if (options.typeErrorCount !== undefined) {
		lines.push(`Type Errors  ${formatTypeErrorLabel(options.typeErrorCount)}`);
	}

	return lines;
}
