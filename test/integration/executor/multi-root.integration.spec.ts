import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "../../../src/backends/interface.ts";
import { loadConfig } from "../../../src/config/loader.ts";
import { resolveAllProjects } from "../../../src/config/projects.ts";
import { runProjects } from "../../../src/executor.ts";
import { generateTestScript } from "../../../src/test-script.ts";
import type { JestResult } from "../../../src/types/jest-result.ts";
import { rojoProjectSchema } from "../../../src/types/rojo.ts";
import { readJsonSync } from "../../e2e/cli/helpers.ts";

const MULTI_ROOT_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/multi-root-project");

const SHARED_MOUNT = "ReplicatedStorage/PkgShared";
const SERVER_MOUNT = "ServerScriptService/PkgServer";

function buildMergedJestResult(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 2,
		numPendingTests: 0,
		numTotalTests: 2,
		startTime: 1_710_000_000_000,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: `${SHARED_MOUNT}/shared.spec.luau`,
				testResults: [
					{
						ancestorTitles: ["shared"],
						duration: 9,
						failureMessages: [],
						fullName: "shared shared",
						status: "passed",
						title: "shared",
					},
				],
			},
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: `${SERVER_MOUNT}/server.spec.luau`,
				testResults: [
					{
						ancestorTitles: ["server"],
						duration: 9,
						failureMessages: [],
						fullName: "server server",
						status: "passed",
						title: "server",
					},
				],
			},
		],
	};
}

async function resolveSingleMultiRootProject() {
	const config = await loadConfig(undefined, MULTI_ROOT_FIXTURE);
	const rojoData = readJsonSync(path.join(MULTI_ROOT_FIXTURE, "default.project.json"));
	const rojo = rojoProjectSchema.assert(rojoData);

	const resolved = await resolveAllProjects(
		config.projects ?? [],
		{ ...config, rootDir: MULTI_ROOT_FIXTURE },
		rojo.tree,
		MULTI_ROOT_FIXTURE,
	);

	const project = resolved[0];
	if (project === undefined) {
		throw new Error("Expected at least one resolved project");
	}

	return project;
}

describe("executor multi-root pipeline", () => {
	it("should drive a single backend invocation that mentions both rojo mounts", async () => {
		expect.assertions(4);

		const project = await resolveSingleMultiRootProject();

		const projectConfig = {
			...project.config,
			placeFile: project.config.placeFile,
			projects: project.projects,
			testMatch: project.testMatch,
		};
		const testFiles = [`${SHARED_MOUNT}/shared.spec`, `${SERVER_MOUNT}/server.spec`];

		let captured: BackendOptions | undefined;
		const fakeBackend: Backend = {
			kind: "open-cloud",
			runTests: async (options): Promise<BackendResult> => {
				captured = options;
				const jestOutput = JSON.stringify({
					_setup: 0.05,
					...buildMergedJestResult(),
				});
				return {
					rawResults: [{ entry: { elapsedMs: 50, jestOutput } }],
					timing: { executionMs: 100, uploadCached: false, uploadMs: 25 },
				};
			},
		};

		const { results } = await runProjects({
			backend: fakeBackend,
			projects: [
				{
					config: projectConfig,
					displayColor: project.displayColor,
					displayName: project.displayName,
					testFiles,
				},
			],
			startTime: Date.now(),
			version: "0.0.0-test",
		});

		// Backend received exactly one job whose config carries both rojo mount
		// dataModel paths. The Open Cloud backend feeds this config straight into
		// generateTestScript, so the script body necessarily mentions both
		// mounts.
		expect(captured?.jobs).toHaveLength(1);
		expect(captured?.jobs[0]?.config.projects).toStrictEqual([SHARED_MOUNT, SERVER_MOUNT]);

		const script = generateTestScript(
			(captured?.jobs ?? []).map((entry) => {
				return { config: entry.config, testFiles: entry.testFiles };
			}),
		);

		expect(script).toMatch(new RegExp(`${SHARED_MOUNT}[\\s\\S]*${SERVER_MOUNT}`));
		expect(results[0]?.output).toContain("2 passed");
	});
});
