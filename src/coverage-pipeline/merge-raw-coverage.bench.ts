/* eslint-disable vitest/prefer-each, vitest/prefer-expect-assertions -- benchmarks are not tests: `bench` declares no assertions and loops to parametrize input size */
import { bench, describe } from "vitest";

import { mergeRawCoverage } from "./merge-raw-coverage.ts";
import type { RawCoverageData } from "./types.ts";

// Workspace coverage folds each project's raw hit counts into a per-package
// total via `mergeRawCoverage`. The cost scales with the file count and the
// statement/function/branch maps per file; this bench guards the additive
// merge against regressions as coverage grows.
function rawCoverage(fileCount: number, entriesPerFile: number): RawCoverageData {
	const data: RawCoverageData = {};
	for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
		const statements: Record<string, number> = {};
		const functions: Record<string, number> = {};
		const branches: Record<string, Array<number>> = {};
		for (let entryIndex = 0; entryIndex < entriesPerFile; entryIndex++) {
			const key = String(entryIndex);
			statements[key] = entryIndex % 3;
			functions[key] = entryIndex % 2;
			branches[key] = [entryIndex % 2, (entryIndex + 1) % 2];
		}

		data[`src/file-${String(fileIndex)}.luau`] = { b: branches, f: functions, s: statements };
	}

	return data;
}

describe(mergeRawCoverage, () => {
	for (const count of [50, 200, 800]) {
		const target = rawCoverage(count, 40);
		const source = rawCoverage(count, 40);
		bench(`merge ${String(count)} files`, () => {
			mergeRawCoverage(target, source);
		});
	}
});
