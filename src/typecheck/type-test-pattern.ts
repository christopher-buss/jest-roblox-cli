import { stripTsExtension } from "../utils/extensions.ts";

const TS_TYPE_TEST_PATTERN = /\.(?:spec|test)-d\.ts$/;
const LUAU_TYPE_TEST_PATTERN = /\.(?:spec|test)-d\.luau$/;

/**
 * Whether a path names a Luau type-test file (`.spec-d.luau` or `.test-d.luau`).
 * @param filePath - The path to check.
 * @returns True for a Luau type-test file.
 */
export function isLuauTypeTestFile(filePath: string): boolean {
	return LUAU_TYPE_TEST_PATTERN.test(filePath);
}

/**
 * Whether a path names a TypeScript or Luau type-test file.
 * @param filePath - The path to check.
 * @returns True for a `.spec-d` or `.test-d` file.
 */
export function isTypeTestFile(filePath: string): boolean {
	return TS_TYPE_TEST_PATTERN.test(filePath) || isLuauTypeTestFile(filePath);
}

const STRIPPED_TYPE_TEST_PATTERN = /\.(?:spec|test)-d$/;

const TYPE_TEST_IGNORE_PATTERN = "\\.(spec|test)-d$";

/**
 * Strip `.ts` from test-match globs and drop the type-test ones.
 * @param patterns - The configured test-match globs.
 * @returns The globs Jest matches inside Roblox.
 */
export function toRobloxTestMatch(patterns: ReadonlyArray<string>): Array<string> {
	return patterns
		.map((pattern) => stripTsExtension(pattern))
		.filter((pattern) => !STRIPPED_TYPE_TEST_PATTERN.test(pattern));
}

/**
 * Add the type-test pattern to the ignore patterns, without duplicates.
 * @param patterns - The configured ignore patterns.
 * @returns The patterns Jest ignores inside Roblox.
 */
export function toRobloxTestPathIgnorePatterns(patterns: ReadonlyArray<string>): Array<string> {
	return [...new Set([...patterns, TYPE_TEST_IGNORE_PATTERN])];
}
