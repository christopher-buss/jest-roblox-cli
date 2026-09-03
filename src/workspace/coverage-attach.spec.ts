import { fromAny } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { loadConfig } from "../config/loader.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import { attachCoverageManifests } from "./coverage-attach.ts";
import type { PendingEntry } from "./test-selection.ts";

const PACKAGE_NAME = "@halcyon/example";

function makePackageDirectory(config: string): string {
	const packageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-attach-"));
	onTestFinished(() => {
		fs.rmSync(packageDirectory, { force: true, recursive: true });
	});
	fs.writeFileSync(path.join(packageDirectory, "jest.config.mjs"), config);

	return packageDirectory;
}

describe(attachCoverageManifests, () => {
	// The report lands wherever `coverageDirectory` resolves, and it resolves
	// against the package's own `rootDir`. Load the config the way workspace
	// mode does — from the package directory, with the invocation directory
	// elsewhere — so a package writing the idiomatic Jest `rootDir: "."` still
	// gets its report beside itself rather than under the workspace root.
	it("should resolve the coverage directory under a relative rootDir's package", async () => {
		expect.assertions(1);

		const packageDirectory = makePackageDirectory(
			'export default { rootDir: ".", test: { coverageDirectory: "coverage" } };',
		);
		const projectConfig = await loadConfig(undefined, packageDirectory);
		const pending: Array<PendingEntry> = [
			fromAny({
				pkg: PACKAGE_NAME,
				project: { displayName: PACKAGE_NAME },
				projectConfig,
				testFiles: [],
			}),
		];
		const coverage: WorkspacePackageCoverage = fromAny({
			pkg: PACKAGE_NAME,
			rootDir: packageDirectory,
		});

		const results: Array<ExecuteResult> = [fromAny({})];

		const [attached] = attachCoverageManifests(
			results,
			pending,
			new Map([[PACKAGE_NAME, coverage]]),
		);

		assert(attached !== undefined);
		assert(attached.coverageSettings !== undefined);

		expect(attached.coverageSettings.coverageDirectory).toBe(
			path.join(packageDirectory, "coverage"),
		);
	});
});
