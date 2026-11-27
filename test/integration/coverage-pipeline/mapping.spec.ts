import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import type { RawCoverageData } from "#src/api.ts";
import {
	instrumentFixtureAsync,
	reportCoverageAsync,
} from "#test/helpers/integration/coverage-run.ts";
import { buildSyntheticCoverage } from "#test/helpers/integration/coverage-spec-synthetic.ts";
import { createRbxtsFixtureSandbox } from "#test/helpers/integration/helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");

function isUnmappedPath(filePath: string): boolean {
	return !filePath.endsWith(".ts") && !filePath.endsWith("jest.config.luau");
}

function isUnmappedLuauPath(filePath: string): boolean {
	return filePath.endsWith(".luau") && !filePath.endsWith("jest.config.luau");
}

async function buildCoverageResultAsync(coverage?: RawCoverageData) {
	const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
	const manifest = await instrumentFixtureAsync(fixtureRoot);
	const coverageData = coverage ?? buildSyntheticCoverage(manifest.files);
	return {
		files: await reportCoverageAsync({ coverageData, manifest, rootDirectory: fixtureRoot }),
	};
}

describe("coverage mapping pipeline (roblox-ts)", { timeout: 30_000 }, () => {
	it("should map luau coverage data to typescript file paths", async ({ expect }) => {
		expect.assertions(3);

		const result = await buildCoverageResultAsync();
		const resultPaths = Object.keys(result.files);

		// Coverage should be keyed by TypeScript paths, not Luau paths
		expect(resultPaths.length).toBeGreaterThan(0);

		const nonTsPaths = resultPaths.filter(isUnmappedPath);

		expect(nonTsPaths).toStrictEqual([]);
		expect(resultPaths.some(isUnmappedLuauPath)).toBeFalse();
	});

	it("should produce statement mappings pointing at typescript source lines", async ({
		expect,
	}) => {
		expect.assertions(2);

		const result = await buildCoverageResultAsync();

		// Find the example.ts coverage (not example.spec.ts)
		const exampleCoverage = Object.entries(result.files).find(([filePath]) => {
			return filePath.endsWith("example.ts");
		});

		expect(exampleCoverage).toBeDefined();

		const [, coverage] = exampleCoverage!;
		const statementLines = Object.values(coverage.statementMap).map(
			(statement) => statement.start.line,
		);

		// Statements should map to valid TS source lines (1-based, within file)
		expect(statementLines.every((line) => line >= 1)).toBeTrue();
	});

	it("should map functions back to typescript", async ({ expect }) => {
		expect.assertions(2);

		const result = await buildCoverageResultAsync();

		const exampleCoverage = Object.entries(result.files).find(([filePath]) => {
			return filePath.endsWith("example.ts");
		});

		expect(exampleCoverage).toBeDefined();

		const [, coverage] = exampleCoverage!;
		const functionNames = Object.values(coverage.fnMap).map((func) => func.name);

		// example.ts exports greet() and add()
		expect(functionNames).toContainEqual("greet");
	});

	it("should resolve source paths relative to source map location", async ({ expect }) => {
		expect.assertions(1);

		const result = await buildCoverageResultAsync();

		// All resolved paths should point to files that actually exist
		const hasEveryPath = Object.keys(result.files).every((filePath) => existsSync(filePath));

		expect(hasEveryPath).toBeTrue();
	});

	it("should report an instrumented file with zero hits when no test exercised it", async ({
		expect,
	}) => {
		expect.assertions(2);

		// No runtime hits at all: every instrumented file is untested.
		const result = await buildCoverageResultAsync({});

		const exampleCoverage = Object.entries(result.files).find(([filePath]) => {
			return filePath.endsWith("example.ts");
		});

		expect(exampleCoverage).toBeDefined();

		const [, coverage] = exampleCoverage!;
		const isEveryStatementZero = Object.values(coverage.s).every((hits) => hits === 0);

		expect(isEveryStatementZero).toBeTrue();
	});
});
