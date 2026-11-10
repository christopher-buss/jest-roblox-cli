import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import { isTypeTestFile } from "../utils/test-file-kind.ts";

/** Test files split by kind. */
export interface ClassifiedTestFiles {
	/** Files that run as runtime tests. */
	runtimeFiles: Array<string>;
	/** Files that run as Type Tests. */
	typeTestFiles: Array<string>;
}

/**
 * Keep the files a `testPathPattern` regex selects.
 * @param files - Candidate test file paths.
 * @param testPathPattern - Regex source, or `undefined`.
 * @returns The selected files.
 */
export function filterByTestPathPattern(
	files: Array<string>,
	testPathPattern: string | undefined,
): Array<string> {
	if (testPathPattern === undefined) {
		return files;
	}

	const pathPattern = new RegExp(testPathPattern);
	return files.filter((file) => pathPattern.test(file));
}

/**
 * Split files into runtime and Type Test files.
 * @param files - Test file paths.
 * @param typecheck - Resolved typecheck config.
 * @returns The runtime and Type Test files.
 */
export function classifyTestFiles(
	files: Array<string>,
	typecheck: ResolvedTypecheckConfig,
): ClassifiedTestFiles {
	const typeTestFiles = typecheck.enabled ? files.filter(isTypeTestFile) : [];
	const runtimeFiles = typecheck.only ? [] : files.filter((file) => !isTypeTestFile(file));
	return { runtimeFiles, typeTestFiles };
}
