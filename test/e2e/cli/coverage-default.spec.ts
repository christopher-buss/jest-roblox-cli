import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	readJsonSync,
	rojoOnPath,
	RUN_TIMEOUT_MS,
	runCliAsync,
} from "#test/harness/helpers.ts";

const FIXTURE = path.resolve(__dirname, "../fixtures/luau-project");
const reportSchema = type({ "[string]": { s: "Record<string, number>" } });

describe.skipIf(!rojoOnPath())("single-mode coverage default", () => {
	it.for<{ collectCoverageFrom: Array<string> | undefined; expected: Array<string> }>([
		{ collectCoverageFrom: undefined, expected: ["selected.luau", "untested.luau"] },
		{ collectCoverageFrom: ["src/selected.luau"], expected: ["selected.luau"] },
	])(
		"should report zero-hit sources within $collectCoverageFrom",
		{ timeout: RUN_TIMEOUT_MS },
		async ({ collectCoverageFrom, expected }) => {
			expect.assertions(3);

			const sandbox = createFixtureSandbox(FIXTURE);
			fs.writeFileSync(path.join(sandbox, "src/selected.luau"), "return 1\n");
			fs.writeFileSync(path.join(sandbox, "src/untested.luau"), "return 2\n");
			fs.writeFileSync(
				path.join(sandbox, "jest.config.ts"),
				`export default ${JSON.stringify({
					luauRoots: ["src"],
					test: {
						collectCoverageFrom,
						coveragePathIgnorePatterns: [
							"**/example*",
							"**/*.spec.luau",
							"**/jest.config.luau",
						],
						coverageReporters: ["json"],
						projects: [
							{
								test: {
									displayName: "single",
									include: ["src/**/*.spec.luau", "src/**/*.spec-d.luau"],
								},
							},
						],
					},
				})};\n`,
			);
			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: `{"runner":{"coverage":{"src/selected.luau":{"s":[0]}}},"success":true,"value":${buildPassingJestOutput()}}`,
				},
			]);
			const result = await runCliAsync(
				["--config", "jest.config.ts", "--coverage", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);
			assert(result.exitCode === 0, `${result.stderr}\n${result.stdout}`);
			const report = reportSchema.assert(
				readJsonSync(path.join(sandbox, "coverage/coverage-final.json")),
			);

			expect(result.exitCode).toBe(0);
			expect(
				Object.keys(report)
					.map((key) => path.basename(key))
					.toSorted(),
			).toStrictEqual(expected);
			expect(Object.values(report).flatMap((entry) => Object.values(entry.s))).toStrictEqual(
				expected.map(() => 0),
			);
		},
	);
});
