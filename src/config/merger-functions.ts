import type { Config, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

type MergerKey =
	| "collectCoverageFrom"
	| "coverageCopyIgnorePatterns"
	| "coveragePathIgnorePatterns"
	| "coverageReporters"
	| "coverageThreshold"
	| "formatters"
	| "luauRoots"
	| "reporters"
	| "roots"
	| "selectProjects"
	| "setupFiles"
	| "setupFilesAfterEnv"
	| "snapshotFormat"
	| "snapshotSerializers"
	| "testMatch"
	| "testPathIgnorePatterns";

type MergerDefault = NonNullable<ResolvedConfig[MergerKey]>;

const EMPTY_ARRAY_DEFAULT_KEYS: ReadonlySet<MergerKey> = new Set<MergerKey>([
	"collectCoverageFrom",
	"formatters",
	"luauRoots",
	"reporters",
	"roots",
	"selectProjects",
	"setupFiles",
	"setupFilesAfterEnv",
	"snapshotSerializers",
]);

const EMPTY_OBJECT_DEFAULT_KEYS: ReadonlySet<MergerKey> = new Set<MergerKey>([
	"coverageThreshold",
	"snapshotFormat",
]);

const MERGEABLE_KEYS: ReadonlySet<string> = new Set<MergerKey>([
	...EMPTY_ARRAY_DEFAULT_KEYS,
	...EMPTY_OBJECT_DEFAULT_KEYS,
	"coverageCopyIgnorePatterns",
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"testMatch",
	"testPathIgnorePatterns",
]);

/**
 * Replace each merger function on a mergeable key, top level and under
 * `test`, with its result against a copy of the default.
 *
 * @param config - Config that may hold merger functions.
 * @returns The config with merger functions resolved to values.
 */
export function resolveFunctionValues({ test, ...rest }: Config): Record<string, unknown> {
	const resolvedRest = Object.fromEntries(
		Object.entries(rest).map(([key, value]) => [
			key,
			isMergerKey(key) && isMergerFunction(value) ? value(defaultForMergerKey(key)) : value,
		]),
	);

	if (test === undefined) {
		return resolvedRest;
	}

	const resolvedTest = Object.fromEntries(
		Object.entries(test).map(([innerKey, innerValue]) => [
			innerKey,
			isMergerKey(innerKey) && isMergerFunction(innerValue)
				? innerValue(defaultForMergerKey(innerKey))
				: innerValue,
		]),
	);

	return { ...resolvedRest, test: resolvedTest };
}

function isMergerFunction(value: unknown): value is (defaults: MergerDefault) => MergerDefault {
	return typeof value === "function";
}

function isMergerKey(key: string): key is MergerKey {
	return MERGEABLE_KEYS.has(key);
}

function defaultForMergerKey(key: MergerKey): MergerDefault {
	const defaultValue = DEFAULT_CONFIG[key];
	if (Array.isArray(defaultValue)) {
		return [...defaultValue];
	}

	if (EMPTY_ARRAY_DEFAULT_KEYS.has(key)) {
		return [];
	}

	return {};
}
