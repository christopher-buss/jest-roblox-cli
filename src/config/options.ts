import { CLI_ONLY_ROWS } from "./cli-only-options.ts";
import type { OptionRow } from "./option-row.ts";
import { ROOT_ROWS } from "./root-options.ts";
import { GLOBAL_TEST_ROWS, PROJECT_TEST_ROWS } from "./test-options.ts";

/** Every config key and CLI flag, one row each. */
export const OPTION_ROWS: ReadonlyArray<OptionRow> = [
	...ROOT_ROWS,
	...GLOBAL_TEST_ROWS,
	...PROJECT_TEST_ROWS.filter(({ location }) => location === "project"),
	...CLI_ONLY_ROWS,
];

/** Rows of config keys, at any location. */
export const CONFIG_ROWS: ReadonlyArray<OptionRow> = OPTION_ROWS.filter(
	({ location }) => location !== "cli",
);

/** Resolved-config keys that reach Jest's argv. */
export const JEST_ARGV_KEYS: ReadonlySet<string> = new Set(
	CONFIG_ROWS.filter((row) => row.jest === true).map(({ key }) => key),
);

/** Project-scope keys a runtime stub may carry. */
export const STUB_KEYS: ReadonlySet<string> = new Set(
	PROJECT_TEST_ROWS.filter((row) => row.jest === true && row.key !== "outDir").map(
		({ key }) => key,
	),
);

/**
 * Whether a key belongs under `test:`.
 *
 * @param key - Config key as written.
 * @returns True for a `test:` key.
 */
export function isTestKey(key: string): boolean {
	return GLOBAL_TEST_ROWS.some((row) => row.key === key);
}
