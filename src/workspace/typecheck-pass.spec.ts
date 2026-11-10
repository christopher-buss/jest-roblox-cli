import { describe, expect, it, vi } from "vitest";

import { makeJestResult } from "#test/mocks/spec-results.ts";
import type { RunTypecheck } from "../typecheck/runner.ts";
import { runWorkspaceTypecheckPassAsync } from "./typecheck-pass.ts";

describe(runWorkspaceTypecheckPassAsync, () => {
	it("should stamp each package onto its file results and split the result by package", async () => {
		expect.assertions(2);

		const runTypecheck = vi.fn<RunTypecheck>(async () => {
			return makeJestResult({
				testResults: [
					{
						numFailingTests: 0,
						numPassingTests: 1,
						numPendingTests: 0,
						testFilePath: "a.spec-d.ts",
						testResults: [],
					},
				],
			});
		});

		const pass = await runWorkspaceTypecheckPassAsync({
			runTypecheck,
			typecheckByDirectory: new Map([
				["/repo/bar", { pkg: "bar", timeout: 1000 }],
				["/repo/foo", { pkg: "foo", timeout: 1000 }],
			]),
			typeTestEntries: [
				{ cwd: "/repo/foo", files: ["a.spec-d.ts"] },
				{ cwd: "/repo/bar", files: ["a.spec-d.ts"] },
			],
		});

		expect(pass.outcome.result!.testResults.map((file) => file.testFilePath)).toStrictEqual([
			"foo/a.spec-d.ts",
			"bar/a.spec-d.ts",
		]);
		expect([...pass.byPackage.keys()]).toStrictEqual(["foo", "bar"]);
	});
});
