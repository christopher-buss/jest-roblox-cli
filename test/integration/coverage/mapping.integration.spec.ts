import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { INSTRUMENTER_VERSION, instrumentRoot } from "../../../src/coverage/instrumenter.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "../../../src/coverage/manifest.ts";
import { MANIFEST_VERSION } from "../../../src/coverage/manifest.ts";
import { mapCoverageToTypeScript } from "../../../src/coverage/mapper.ts";
import type { RawCoverageData } from "../../../src/coverage/types.ts";
import { normalizeWindowsPath } from "../../../src/utils/normalize-windows-path.ts";
import { createRbxtsFixtureSandbox } from "../../e2e/cli/helpers.ts";

const normalize = normalizeWindowsPath;
const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "jest-roblox-e2e-cov-"));
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

function buildManifest(
	files: Record<string, InstrumentedFileRecord>,
	fixtureOut: string,
	shadowDirectory: string,
): CoverageManifest {
	return {
		buildId: "test-build-id",
		files,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: [normalize(fixtureOut)],
		nonInstrumentedFiles: {},
		shadowDir: normalize(shadowDirectory),
		version: MANIFEST_VERSION,
	};
}

function buildSyntheticCoverage(files: Record<string, InstrumentedFileRecord>): RawCoverageData {
	const data: RawCoverageData = {};

	for (const [fileKey, record] of Object.entries(files)) {
		const statementHits: Record<string, number> = {};
		for (let index = 0; index < record.statementCount; index++) {
			statementHits[String(index)] = 1;
		}

		const functionHits: Record<string, number> = {};
		for (let index = 0; index < (record.functionCount ?? 0); index++) {
			functionHits[String(index)] = 1;
		}

		const branchHits: Record<string, Array<number>> = {};
		for (let index = 0; index < (record.branchCount ?? 0); index++) {
			branchHits[String(index)] = [1, 1];
		}

		data[fileKey] = { b: branchHits, f: functionHits, s: statementHits };
	}

	return data;
}

function buildCoverageResult() {
	const shadowDirectory = createTemporaryDirectory();
	const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
	const fixtureOut = path.join(fixtureRoot, "out");
	const files = instrumentRoot({
		luauRoot: fixtureOut,
		shadowDir: shadowDirectory,
	});
	const manifest = buildManifest(files, fixtureOut, shadowDirectory);
	const coverageData = buildSyntheticCoverage(files);
	return mapCoverageToTypeScript(coverageData, manifest);
}

describe("coverage mapping pipeline (roblox-ts)", () => {
	it("should map luau coverage data to typescript file paths", () => {
		expect.assertions(3);

		const result = buildCoverageResult();
		const resultPaths = Object.keys(result.files);

		// Coverage should be keyed by TypeScript paths, not Luau paths
		expect(resultPaths.length).toBeGreaterThan(0);

		const nonTsPaths = resultPaths.filter((filePath) => {
			return !filePath.endsWith(".ts") && !filePath.endsWith("jest.config.luau");
		});

		expect(nonTsPaths).toStrictEqual([]);
		expect(
			resultPaths.some(
				(filePath) =>
					filePath.endsWith(".luau") && !filePath.endsWith("jest.config.luau"),
			),
		).toBeFalse();
	});

	it("should produce statement mappings pointing at typescript source lines", () => {
		expect.assertions(2);

		const result = buildCoverageResult();

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

	it("should map functions back to typescript", () => {
		expect.assertions(2);

		const result = buildCoverageResult();

		const exampleCoverage = Object.entries(result.files).find(([filePath]) => {
			return filePath.endsWith("example.ts");
		});

		expect(exampleCoverage).toBeDefined();

		const [, coverage] = exampleCoverage!;
		const functionNames = Object.values(coverage.fnMap).map((func) => func.name);

		// example.ts exports greet() and add()
		expect(functionNames).toContainEqual("greet");
	});

	it("should resolve source paths relative to source map location", () => {
		expect.assertions(1);

		const result = buildCoverageResult();

		// All resolved paths should point to files that actually exist
		const allPathsExist = Object.keys(result.files).every((filePath) => existsSync(filePath));

		expect(allPathsExist).toBeTrue();
	});
});
