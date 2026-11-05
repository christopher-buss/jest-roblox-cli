import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import { fakeTimingCollector, phaseNamesOf } from "#test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import {
	attachCoverageManifests,
	type PrepareCoverage,
	prepareWorkspaceCoverageMap,
} from "./coverage-attach.ts";
import type { PendingEntry } from "./pending-entry.ts";

const PACKAGE_NAME = "@halcyon/example";

const WORKSPACE_ROOT = path.resolve("/repo");
const PACKAGE_DIRECTORY = path.join(WORKSPACE_ROOT, "packages", "example");

describe(attachCoverageManifests, () => {
	it("should resolve the coverage directory under the package's rootDir", () => {
		expect.assertions(1);

		const projectConfig = createResolvedConfig({
			coverageDirectory: "coverage",
			rootDir: PACKAGE_DIRECTORY,
		});
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
			rootDir: PACKAGE_DIRECTORY,
		});

		const results: Array<ExecuteResult> = [fromAny({})];

		const [attached] = attachCoverageManifests({
			coverageByPackage: new Map([[PACKAGE_NAME, coverage]]),
			pending,
			results,
		});

		assert(attached !== undefined);
		assert(attached.coverageSettings !== undefined);

		expect(attached.coverageSettings.coverageDirectory).toBe(
			path.join(PACKAGE_DIRECTORY, "coverage"),
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
