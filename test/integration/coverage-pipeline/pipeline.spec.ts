import path from "node:path";
import { describe, expect, it } from "vitest";

import { createRbxtsFixtureSandbox } from "#test/harness/helpers.ts";
import {
	instrumentFixtureAsync,
	reportCoverageAsync,
} from "#test/integration/coverage-pipeline/coverage-run.ts";
import { buildSyntheticCoverage } from "#test/mocks/coverage-spec-synthetic.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");

function normalizePath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

/**
 * A report key the mapper resolved back to TypeScript. The generated
 * `jest.config.luau` has no TS twin, so it is expected to stay Luau.
 * @param key - Key of the Istanbul JSON report.
 * @returns Whether the key is TypeScript or `jest.config.luau`.
 */
function isMappedReportKey(key: string): boolean {
	return key.endsWith(".ts") || key.endsWith("jest.config.luau");
}

describe("coverage pipeline (mapper -> istanbul json reporter)", { timeout: 30_000 }, () => {
	it("should write coverage-final.json keyed by ts paths with sane statement/fn maps", async () => {
		expect.assertions(4);

		const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		const manifest = await instrumentFixtureAsync(fixtureRoot);
		const coverageData = buildSyntheticCoverage(manifest.files);

		const report = await reportCoverageAsync({
			coverageData,
			manifest,
			rootDirectory: fixtureRoot,
		});

		const exampleEntry = Object.values(report).find((entry) => {
			return normalizePath(entry.path).endsWith("/src/example.ts");
		});

		expect(exampleEntry).toBeDefined();
		expect(Object.keys(report).every(isMappedReportKey)).toBeTrue();
		expect(
			Object.values(exampleEntry!.statementMap).every(
				(statement) => statement.start.line >= 1,
			),
		).toBeTrue();
		expect(Object.values(exampleEntry!.fnMap).map((entry) => entry.name)).toContain("greet");
	});
});
