import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import { fakeTimingCollector, phaseNamesOf } from "../../test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { loadConfig } from "../config/loader.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import {
	attachCoverageManifests,
	type PrepareCoverage,
	prepareWorkspaceCoverageMap,
} from "./coverage-attach.ts";
import type { PendingEntry } from "./test-selection.ts";

const PACKAGE_NAME = "@halcyon/example";

const WORKSPACE_ROOT = path.resolve("/repo");
const PACKAGE_DIRECTORY = path.join(WORKSPACE_ROOT, "packages", "example");

async function loadPackageConfigAsync(config: Record<string, unknown>): Promise<ResolvedConfig> {
	const configFile = path.join(PACKAGE_DIRECTORY, "jest.config.mjs");
	const { fileSystem } = createMemoryFileSystem({ [configFile]: "" });
	const configLoader = vi.fn<(options: LoadConfigOptions) => Promise<C12ResolvedConfig>>();
	configLoader.mockResolvedValue({ config, configFile, cwd: PACKAGE_DIRECTORY, layers: [] });

	return loadConfig({ configLoader: fromAny(configLoader), cwd: WORKSPACE_ROOT, fileSystem });
}

describe(attachCoverageManifests, () => {
	// The report lands wherever `coverageDirectory` resolves, and it resolves
	// against the package's own `rootDir`. Load the config the way workspace
	// mode does — from the package directory, with the invocation directory
	// elsewhere — so a package writing the idiomatic Jest `rootDir: "."` still
	// gets its report beside itself rather than under the workspace root.
	it("should resolve the coverage directory under a relative rootDir's package", async () => {
		expect.assertions(1);

		const projectConfig = await loadPackageConfigAsync({
			rootDir: ".",
			test: { coverageDirectory: "coverage" },
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
