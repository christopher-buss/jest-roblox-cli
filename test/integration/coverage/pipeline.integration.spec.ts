import { type } from "arktype";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { INSTRUMENTER_VERSION, instrumentRoot } from "../../../src/coverage/instrumenter.ts";
import { mapCoverageToTypeScript } from "../../../src/coverage/mapper.ts";
import { generateReports } from "../../../src/coverage/reporter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	RawCoverageData,
} from "../../../src/coverage/types.ts";
import { normalizeWindowsPath } from "../../../src/utils/normalize-windows-path.ts";
import { createRbxtsFixtureSandbox } from "../../e2e/cli/helpers.ts";

const normalize = normalizeWindowsPath;
const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");

const coverageReportSchema = type({
	"[string]": {
		b: "object",
		branchMap: "object",
		f: "object",
		fnMap: type({
			"[string]": {
				name: "string",
				loc: {
					end: { column: "number", line: "number" },
					start: { column: "number", line: "number" },
				},
			},
		}),
		path: "string",
		s: "object",
		statementMap: type({
			"[string]": {
				end: { column: "number", line: "number" },
				start: { column: "number", line: "number" },
			},
		}),
	},
});

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "jest-roblox-cov-pipeline-"));
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
		files,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: [normalize(fixtureOut)],
		nonInstrumentedFiles: {},
		shadowDir: normalize(shadowDirectory),
		version: 1,
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

function normalizePath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

describe("coverage pipeline (mapper -> istanbul json reporter)", () => {
	it("should write coverage-final.json keyed by ts paths with sane statement/fn maps", () => {
		expect.assertions(4);

		const shadowDirectory = createTemporaryDirectory();
		const reportDirectory = createTemporaryDirectory();
		const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		const fixtureOut = path.join(fixtureRoot, "out");

		const files = instrumentRoot({ luauRoot: fixtureOut, shadowDir: shadowDirectory });
		const manifest = buildManifest(files, fixtureOut, shadowDirectory);
		const coverageData = buildSyntheticCoverage(files);

		const mapped = mapCoverageToTypeScript(coverageData, manifest);

		generateReports({
			coverageDirectory: reportDirectory,
			mapped,
			reporters: ["json"],
		});

		const reportPath = path.join(reportDirectory, "coverage-final.json");
		const report = coverageReportSchema.assert(JSON.parse(readFileSync(reportPath, "utf-8")));

		const exampleEntry = Object.values(report).find((entry) => {
			return normalizePath(entry.path).endsWith("/src/example.ts");
		});

		expect(exampleEntry).toBeDefined();
		expect(
			Object.keys(report).every(
				(key) => key.endsWith(".ts") || key.endsWith("jest.config.lua"),
			),
		).toBeTrue();
		expect(
			Object.values(exampleEntry?.statementMap ?? {}).every(
				(statement) => statement.start.line >= 1,
			),
		).toBeTrue();
		expect(Object.values(exampleEntry?.fnMap ?? {}).map((entry) => entry.name)).toContain(
			"greet",
		);
	});
});
