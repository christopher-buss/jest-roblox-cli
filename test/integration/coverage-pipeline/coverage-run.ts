import { fromPartial } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { onTestFinished, vi } from "vitest";

import { type CliDependencies, runAsync } from "#src/cli.ts";
import {
	buildCoveragePlaceAsync,
	type CoverageManifest,
	type MultiRunResult,
	type RawCoverageData,
	readCoverageManifest,
	type runJestRobloxAsync,
} from "#src/index.ts";
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

export async function reportCoverageAsync({
	coverageData,
	rootDirectory,
}: {
	coverageData: RawCoverageData;
	rootDirectory: string;
}): Promise<CoverageReport> {
	const coverageDirectory = path.join(rootDirectory, "coverage");
	const result = fromPartial<MultiRunResult>({
		merged: { coverageData },
		mode: "multi",
		projectResults: [
			{
				displayName: "fixture",
				result: { coverageData, exitCode: 0, output: "", result: PASSING_RUN },
			},
		],
	});

	const exitCode = await runAsync(["--coverage", "--coverageReporters", "json", "--silent"], {
		loadConfig: vi
			.fn<NonNullable<CliDependencies["loadConfig"]>>()
			.mockResolvedValue(
				createResolvedConfig({ coverageDirectory, rootDir: rootDirectory, silent: true }),
			),
		runJestRoblox: vi.fn<typeof runJestRobloxAsync>().mockResolvedValue(result),
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

function enterDirectory(rootDirectory: string): void {
	const previous = process.cwd();
	process.chdir(rootDirectory);
	onTestFinished(() => {
		process.chdir(previous);
	});
}
