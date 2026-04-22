import { type } from "arktype";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { INSTRUMENTER_VERSION } from "../../src/coverage/instrumenter.ts";
import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import { createRbxtsFixtureSandbox, readJsonFile, runCliAsync } from "./helpers.ts";

const COVERAGE_DIR = ".jest-roblox-coverage";
const RBXTS_FIXTURE = path.resolve(__dirname, "fixtures/rbxts-project");

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

describe("cli coverage", () => {
	it("should emit coverage reports mapped back to TypeScript paths", async () => {
		expect.assertions(5);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		seedCoverageCache(sandbox);

		const server = await startFakeOpenCloudServer([
			{
				jestOutput: buildMixedOutput({
					_coverage: {
						"out/example.luau": {
							f: { "0": 1, "1": 1 },
							s: { "0": 1, "1": 1 },
						},
					},
					success: true,
					value: {
						numFailedTests: 0,
						numPassedTests: 1,
						numPendingTests: 0,
						numTotalTests: 1,
						startTime: 1_710_000_000_000,
						success: true,
						testResults: [
							{
								numFailingTests: 0,
								numPassingTests: 1,
								numPendingTests: 0,
								testFilePath: "ReplicatedStorage/shared/example.spec",
								testResults: [
									{
										ancestorTitles: ["coverage"],
										duration: 10,
										failureMessages: [],
										fullName: "coverage example",
										status: "passed",
										title: "maps",
									},
								],
							},
						],
					},
				}),
			},
		]);

		const result = await runCliAsync(
			[
				"--backend",
				"open-cloud",
				"--coverage",
				"--coverageDirectory",
				"coverage",
				"--coverageReporters",
				"json",
			],
			{
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
			},
		);

		const coverage = readJsonFile(
			path.join(sandbox, "coverage", "coverage-final.json"),
			coverageReportSchema,
		);
		const exampleCoverage = Object.values(coverage).find((entry) => {
			return normalizePath(entry.path).endsWith("/src/example.ts");
		});

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toStrictEqual({
			exitCode: 0,
			stderr: "",
		});
		expect(result.stdout).toContain("Coverage report from istanbul");
		expect(exampleCoverage).toBeDefined();
		expect(
			Object.values(exampleCoverage?.statementMap ?? {}).every(
				(statement) => statement.start.line >= 1,
			),
		).toBeTrue();
		expect(Object.values(exampleCoverage?.fnMap ?? {}).map((entry) => entry.name)).toContain(
			"greet",
		);
	});
});

function buildMixedOutput(payload: Record<string, unknown>): string {
	return [
		"Preparing fake coverage payload",
		JSON.stringify(payload),
		"Coverage payload ready",
	].join("\n");
}

function createOpenCloudEnvironment(baseUrl: string): Record<string, string> {
	const { port } = new URL(baseUrl);

	return {
		JEST_ROBLOX_OPEN_CLOUD_BASE_URL: baseUrl,
		ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
		ROBLOX_PLACE_ID: `place-${port}`,
		ROBLOX_UNIVERSE_ID: `universe-${port}`,
	};
}

function normalizePath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

function hashFile(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function seedCoverageCache(rootDirectory: string): void {
	const coverageRoot = path.join(rootDirectory, COVERAGE_DIR);
	const shadowOut = path.join(coverageRoot, "out");
	mkdirSync(shadowOut, { recursive: true });

	copyFileSync(path.join(rootDirectory, "game.rbxl"), path.join(coverageRoot, "game.rbxl"));
	copyFileSync(
		path.join(rootDirectory, "out", "example.luau"),
		path.join(shadowOut, "example.luau"),
	);
	copyFileSync(
		path.join(rootDirectory, "out", "example.spec.luau"),
		path.join(shadowOut, "example.spec.luau"),
	);
	copyFileSync(
		path.join(rootDirectory, "out", "jest.config.lua"),
		path.join(shadowOut, "jest.config.lua"),
	);

	writeFileSync(
		path.join(shadowOut, "example.luau.cov-map.json"),
		JSON.stringify({
			functionMap: {
				"0": {
					name: "greet",
					location: {
						end: { column: 3, line: 4 },
						start: { column: 1, line: 2 },
					},
				},
				"1": {
					name: "add",
					location: {
						end: { column: 3, line: 7 },
						start: { column: 1, line: 5 },
					},
				},
			},
			statementMap: {
				"0": {
					end: { column: 19, line: 3 },
					start: { column: 1, line: 2 },
				},
				"1": {
					end: { column: 14, line: 6 },
					start: { column: 1, line: 5 },
				},
			},
		}),
	);

	writeFileSync(
		path.join(coverageRoot, "manifest.json"),
		JSON.stringify(
			{
				files: {
					"out/example.luau": {
						key: "out/example.luau",
						coverageMapPath: normalizePath(
							path.join(coverageRoot, "out", "example.luau.cov-map.json"),
						),
						functionCount: 2,
						instrumentedLuauPath: normalizePath(
							path.join(coverageRoot, "out", "example.luau"),
						),
						originalLuauPath: normalizePath(
							path.join(rootDirectory, "out", "example.luau"),
						),
						sourceHash: hashFile(path.join(rootDirectory, "out", "example.luau")),
						sourceMapPath: normalizePath(
							path.join(rootDirectory, "out", "example.luau.map"),
						),
						statementCount: 2,
					},
					"out/jest.config.lua": {
						key: "out/jest.config.lua",
						coverageMapPath: normalizePath(
							path.join(coverageRoot, "out", "jest.config.lua.cov-map.json"),
						),
						instrumentedLuauPath: normalizePath(
							path.join(coverageRoot, "out", "jest.config.lua"),
						),
						originalLuauPath: normalizePath(
							path.join(rootDirectory, "out", "jest.config.lua"),
						),
						sourceHash: hashFile(path.join(rootDirectory, "out", "jest.config.lua")),
						sourceMapPath: normalizePath(
							path.join(rootDirectory, "out", "jest.config.lua.map"),
						),
						statementCount: 0,
					},
				},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: ["out"],
				nonInstrumentedFiles: {
					"out/example.spec.luau": {
						shadowPath: normalizePath(
							path.join(coverageRoot, "out", "example.spec.luau"),
						),
						sourceHash: hashFile(path.join(rootDirectory, "out", "example.spec.luau")),
						sourcePath: normalizePath(
							path.join(rootDirectory, "out", "example.spec.luau"),
						),
					},
				},
				placeFilePath: normalizePath(path.join(coverageRoot, "game.rbxl")),
				shadowDir: COVERAGE_DIR,
				version: 1,
			},
			undefined,
			"\t",
		),
	);
}
