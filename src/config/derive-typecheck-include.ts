/**
 * Derives Type Test include globs from a project's Runtime `include` by
 * inserting the `-d` marker into the trailing `.spec.ts` / `.test.ts` suffix
 * (`.spec.ts` → `.spec-d.ts`, `.test.ts` → `.test-d.ts`).
 *
 * Only `.ts` patterns produce Type Tests (the runtime classifier matches
 * `/\.(test-d|spec-d)\.ts$/`), so patterns ending in any other extension, lacking
 * a trailing `.spec.`/`.test.` marker, or already carrying `-d` are dropped.
 */
const SpecTsSuffixPattern = /\.spec\.ts$/;
const TestTsSuffixPattern = /\.test\.ts$/;

export function deriveTypecheckInclude(runtimeInclude: ReadonlyArray<string>): Array<string> {
	const derived: Array<string> = [];
	for (const pattern of runtimeInclude) {
		if (SpecTsSuffixPattern.test(pattern)) {
			derived.push(pattern.replace(SpecTsSuffixPattern, ".spec-d.ts"));
		} else if (TestTsSuffixPattern.test(pattern)) {
			derived.push(pattern.replace(TestTsSuffixPattern, ".test-d.ts"));
		}
	}

	return derived;
}
