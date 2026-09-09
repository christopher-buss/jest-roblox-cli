import { fromAny } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { fakeTimingCollector, phaseNamesOf } from "../../test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { loadConfig } from "../config/loader.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import {
	attachCoverageManifests,
	type PrepareCoverage,
	prepareWorkspaceCoverageMap,
} from "./coverage-attach.ts";
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

describe(prepareWorkspaceCoverageMap, () => {
	it("should time opted-in coverage without warning about its enforceable threshold", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem();
		const timing = fakeTimingCollector(17);
		const coverage = fromAny<WorkspacePackageCoverage, unknown>({ pkg: PACKAGE_NAME });
		const prepareCoverage = vi.fn<PrepareCoverage>(() => [coverage]);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const result = prepareWorkspaceCoverageMap({
			contexts: [
				fromAny({
					info: { name: "@halcyon/without-coverage" },
					pkgConfig: { collectCoverage: false },
				}),
				fromAny({
					info: { name: PACKAGE_NAME },
					pkgConfig: {
						collectCoverage: true,
						coverageThreshold: { global: { lines: 90 } },
					},
				}),
			],
			fileSystem,
			loaded: [fromAny({ descriptor: { name: PACKAGE_NAME } })],
			pending: [fromAny({ pkg: PACKAGE_NAME })],
			prepareCoverage,
			timing,
			workspaceRoot: "/workspace",
		});

		expect(result).toStrictEqual({
			elapsedMs: 17,
			value: new Map([[PACKAGE_NAME, coverage]]),
		});
		expect(phaseNamesOf(timing.profileTimed)).toStrictEqual(["prepareCoverage"]);
		expect(stderr).not.toHaveBeenCalled();
	});
});
