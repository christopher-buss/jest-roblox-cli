/**
 * Derives Type Test include globs from a project's Runtime `include` by
 * inserting the `-d` marker into the trailing `.spec.ts` / `.test.ts` suffix
 * (`.spec.ts` → `.spec-d.ts`, `.test.ts` → `.test-d.ts`).
 *
 * Only `.ts` patterns produce Type Tests (the runtime classifier matches
 * `/\.(test-d|spec-d)\.ts$/`), so patterns ending in any other extension,
 * lacking a trailing `.spec.`/`.test.` marker, or already carrying `-d` are
 * dropped.
 */
const SPEC_TS_SUFFIX_PATTERN = /\.spec\.ts$/;
const TEST_TS_SUFFIX_PATTERN = /\.test\.ts$/;

export function deriveTypecheckInclude(runtimeInclude: ReadonlyArray<string>): Array<string> {
	const derived: Array<string> = [];
	for (const pattern of runtimeInclude) {
		if (SPEC_TS_SUFFIX_PATTERN.test(pattern)) {
			derived.push(pattern.replace(SPEC_TS_SUFFIX_PATTERN, ".spec-d.ts"));
		} else if (TEST_TS_SUFFIX_PATTERN.test(pattern)) {
			derived.push(pattern.replace(TEST_TS_SUFFIX_PATTERN, ".test-d.ts"));
		}
	}

	return derived;
}
