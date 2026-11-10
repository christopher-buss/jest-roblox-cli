import { fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished, vi } from "vitest";

import {
	buildCoveragePlaceAsync,
	type CoverageManifest,
	type RawCoverageData,
	readCoverageManifest,
	type RunResult,
} from "#src/api.ts";
import { type CliDependencies, runAsync } from "#src/cli.ts";
import { mapCoverageToTypeScript } from "#src/coverage-report/mapper.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

const PASSING_RUN = {
	numFailedTests: 0,
	numPassedTests: 0,
	numPendingTests: 0,
	numTotalTests: 0,
	startTime: 0,
	success: true,
	testResults: [],
};

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
		s: "Record<string, number>",
		statementMap: type({
			"[string]": {
				end: { column: "number", line: "number" },
				start: { column: "number", line: "number" },
			},
		}),
	},
});

export type CoverageReport = typeof coverageReportSchema.infer;

interface CoverageInput {
	coverageData: RawCoverageData;
	manifest: CoverageManifest;
	rootDirectory: string;
}

export async function reportCoverageAsync(input: CoverageInput): Promise<CoverageReport> {
	const coverageDirectory = path.join(input.rootDirectory, "coverage");
	const exitCode = await runAsync(["--coverage", "--coverageReporters", "json", "--silent"], {
		loadConfig: vi.fn<NonNullable<CliDependencies["loadConfig"]>>().mockResolvedValue(
			createResolvedConfig({
				coverageDirectory,
				rootDir: input.rootDirectory,
				silent: true,
			}),
		),
		runJestRoblox: vi
			.fn<NonNullable<CliDependencies["runJestRoblox"]>>()
			.mockResolvedValue(mappedRunResult(input)),
	});
	if (exitCode !== 0) {
		throw new Error(`The coverage report run exited with ${exitCode}`);
	}

	return coverageReportSchema.assert(
		JSON.parse(readFileSync(path.join(coverageDirectory, "coverage-final.json"), "utf-8")),
	);
}

export async function instrumentFixtureAsync(rootDirectory: string): Promise<CoverageManifest> {
	enterDirectory(rootDirectory);
	const { coverageManifestPath } = await buildCoveragePlaceAsync(
		createResolvedConfig({ rootDir: rootDirectory, silent: true }),
	);
	const read = readCoverageManifest(path.resolve(rootDirectory, coverageManifestPath));
	if (read.kind !== "ok") {
		throw new Error(`No coverage manifest was written for ${rootDirectory}`);
	}

	return read.manifest;
}

function mappedRunResult({ coverageData, manifest, rootDirectory }: CoverageInput): RunResult {
	return fromPartial<RunResult>({
		coverage: {
			units: [
				{
					coverageDirectory: path.join(rootDirectory, "coverage"),
					reporters: ["json"],
					universe: mapCoverageToTypeScript({ coverageData, manifest }),
				},
			],
		},
		output: { collectCoverage: true, rootDir: rootDirectory, silent: true },
		projectResults: [
			{
				displayName: "fixture",
				result: {
					coverageData,
					exitCode: 0,
					result: PASSING_RUN,
					timing: { executionMs: 1, startTime: 0, testsMs: 1, totalMs: 1, uploadMs: 0 },
				},
			},
		],
	});
}

function enterDirectory(rootDirectory: string): void {
	const previous = process.cwd();
	process.chdir(rootDirectory);
	onTestFinished(() => {
		process.chdir(previous);
	});
}
