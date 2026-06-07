/**
 * Derives Type Test include globs from a project's Runtime `include` by
 * inserting the `-d` marker into the trailing `.spec.ts` / `.test.ts` suffix
 * (`.spec.ts` → `.spec-d.ts`, `.test.ts` → `.test-d.ts`).
 *
 * Only `.ts` patterns produce Type Tests (the runtime classifier matches
 * `/\.(test-d|spec-d)\.ts$/`), so patterns ending in any other extension, lacking
 * a trailing `.spec.`/`.test.` marker, or already carrying `-d` are dropped.
 */
export function deriveTypecheckInclude(runtimeInclude: ReadonlyArray<string>): Array<string> {
	const derived: Array<string> = [];
	for (const pattern of runtimeInclude) {
		if (/\.spec\.ts$/.test(pattern)) {
			derived.push(pattern.replace(/\.spec\.ts$/, ".spec-d.ts"));
		} else if (/\.test\.ts$/.test(pattern)) {
			derived.push(pattern.replace(/\.test\.ts$/, ".test-d.ts"));
		}
	}

	return derived;
}
