import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import { fakeTimingCollector, phaseNamesOf } from "#test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { WorkspacePackageCoverage } from "../shadow/workspace-prepare.ts";
import {
	attachCoverageManifests,
	type PrepareCoverage,
	prepareWorkspaceCoverageMap,
} from "./coverage-attach.ts";
import type { PendingEntry } from "./test-selection.ts";

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
				job: { config: projectConfig, pkg: PACKAGE_NAME },
				project: { displayName: PACKAGE_NAME },
			}),
		];
		const coverage: WorkspacePackageCoverage = fromAny({
			pkg: PACKAGE_NAME,
			rootDir: PACKAGE_DIRECTORY,
		});

		const results: Array<ExecuteResult & { jobIndex: number }> = [fromAny({ jobIndex: 0 })];

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

describe("attachCoverageManifests pairing", () => {
	it("should pair each result with the pending entry its jobIndex names", () => {
		expect.assertions(1);

		const pending: Array<PendingEntry> = ["first", "second"].map((name) => {
			return fromAny({
				job: { config: createResolvedConfig({ rootDir: PACKAGE_DIRECTORY }), pkg: name },
				project: { displayName: name },
			});
		});

		const attached = attachCoverageManifests({
			coverageByPackage: new Map(),
			pending,
			results: [fromAny({ jobIndex: 1 })],
		});

		expect(attached.map((entry) => entry.pkg)).toStrictEqual(["second"]);
	});

	it("should carry the project's label color", () => {
		expect.assertions(1);

		const [attached] = attachCoverageManifests({
			coverageByPackage: new Map(),
			pending: [
				fromAny({
					job: { config: createResolvedConfig(), pkg: PACKAGE_NAME },
					project: { displayColor: "magenta", displayName: "client" },
				}),
			],
			results: [fromAny({ jobIndex: 0 })],
		});

		expect(attached!.displayColor).toBe("magenta");
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
			cacheDirectory: "/workspace/.jest-roblox/workspace",
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
			loaded: [
				fromAny({
					descriptor: { name: PACKAGE_NAME },
					info: { name: PACKAGE_NAME },
					pkgConfig: createResolvedConfig(),
				}),
			],
			pending: [fromAny({ job: { pkg: PACKAGE_NAME } })],
			prepareCoverage,
			timing,
		});

		expect(result).toStrictEqual({
			elapsedMs: 17,
			value: new Map([[PACKAGE_NAME, coverage]]),
		});
		expect(phaseNamesOf(timing.profileTimed)).toStrictEqual(["prepareCoverage"]);
		expect(stderr).not.toHaveBeenCalled();
	});
});
