/* eslint-disable flawless/prefer-ending-with-an-expect, vitest/consistent-test-it, vitest/expect-expect, vitest/prefer-expect-assertions, vitest/valid-title -- the eslint plugin still models `bench` as a Vitest 4 top-level test. It now registers a measurement inside the host test, so the assertion and title rules aim at the wrong call, and the host itself measures rather than asserts. */
import { describe, it } from "vitest";

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

const FILE_COUNTS = [50, 200, 800];

const ENTRIES_PER_FILE = 40;

describe(mergeRawCoverage, () => {
	it("should benchmark the additive merge", async ({ bench }) => {
		await bench.compare(
			...FILE_COUNTS.map((count) => {
				const target = rawCoverage(count, ENTRIES_PER_FILE);
				const source = rawCoverage(count, ENTRIES_PER_FILE);
				return bench(`${String(count)} files`, () => {
					mergeRawCoverage(target, source);
				});
			}),
		);
	});
});
