import { stripTsExtension } from "../utils/extensions.ts";

const TS_TYPE_TEST_PATTERN = /\.(?:spec|test)-d\.ts$/;
const LUAU_TYPE_TEST_PATTERN = /\.(?:spec|test)-d\.luau$/;

export function isLuauTypeTestFile(filePath: string): boolean {
	return LUAU_TYPE_TEST_PATTERN.test(filePath);
}

export function isTypeTestFile(filePath: string): boolean {
	return TS_TYPE_TEST_PATTERN.test(filePath) || isLuauTypeTestFile(filePath);
}

const STRIPPED_TYPE_TEST_PATTERN = /\.(?:spec|test)-d$/;

const TYPE_TEST_IGNORE_PATTERN = "\\.(spec|test)-d$";

export function toRobloxTestMatch(patterns: ReadonlyArray<string>): Array<string> {
	return patterns
		.map((pattern) => stripTsExtension(pattern))
		.filter((pattern) => !STRIPPED_TYPE_TEST_PATTERN.test(pattern));
}

export function toRobloxTestPathIgnorePatterns(
	patterns: ReadonlyArray<string> = [],
): Array<string> {
	return [...new Set([...patterns, TYPE_TEST_IGNORE_PATTERN])];
}
