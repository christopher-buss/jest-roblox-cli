import { stripTsExtension } from "./extensions.ts";

const TEST_SUFFIX = "(spec|test)";
const TYPE_TEST_SUFFIX = String.raw`\.${TEST_SUFFIX}-d`;

const TS_TYPE_TEST_PATTERN = new RegExp(String.raw`${TYPE_TEST_SUFFIX}\.ts$`);
const LUAU_TYPE_TEST_PATTERN = new RegExp(String.raw`${TYPE_TEST_SUFFIX}\.luau$`);
const STRIPPED_TYPE_TEST_PATTERN = new RegExp(`${TYPE_TEST_SUFFIX}$`);
const RUNTIME_TEST_PATTERN = new RegExp(String.raw`\.${TEST_SUFFIX}\.(ts|luau)$`);
const TEST_MARKER_PATTERN = new RegExp(String.raw`\.${TEST_SUFFIX}(?:-d)?(\.[^./]+)$`);
const LUAU_TEST_PATTERN = new RegExp(String.raw`\.${TEST_SUFFIX}\.luau?$`);

const TYPE_TEST_IGNORE_PATTERN = `${TYPE_TEST_SUFFIX}$`;

/**
 * The source file a test file covers: `a.spec.ts` and `a.spec-d.ts` give `a.ts`.
 * @param filePath - A test file path.
 * @returns The path with its test marker dropped; other paths unchanged.
 */
export function sourceTwinOf(filePath: string): string {
	return filePath.replace(TEST_MARKER_PATTERN, "$2");
}

/**
 * Whether a file name is a Luau runtime test (`.spec.luau`, `.test.lua`).
 * @param filePath - The path to check.
 * @returns True for a Luau runtime test file.
 */
export function isLuauTestFile(filePath: string): boolean {
	return LUAU_TEST_PATTERN.test(filePath);
}

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

/**
 * The type-test glob beside a runtime test glob: `*.spec.ts` gives `*.spec-d.ts`.
 * @param pattern - A runtime test glob.
 * @returns The glob with its runtime suffix turned into the type-test one.
 */
export function toTypeTestPattern(pattern: string): string {
	return pattern.replace(RUNTIME_TEST_PATTERN, ".$1-d.$2");
}

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
