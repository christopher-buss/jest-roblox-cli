import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { loadConfig } from "../config/loader.ts";
import { mergeCliWithConfig } from "../config/merge.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { loadWorkspacePackagesAsync } from "./package-loader.ts";

vi.mock(import("../config/loader.ts"));
vi.mock(import("../config/merge.ts"));

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rootDir: "/repo/packages/example",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function createTiming(): TimingCollector {
	return fromAny({
		profileAsync: vi.fn<(name: string, action: () => Promise<unknown>) => Promise<unknown>>(
			async (_name, action) => action(),
		),
	});
}

describe(loadWorkspacePackagesAsync, () => {
	it("should load each package config and build a default descriptor", async () => {
		expect.assertions(4);

		const fileConfig = makeConfig();
		vi.mocked(loadConfig).mockResolvedValue(fileConfig);
		vi.mocked(mergeCliWithConfig).mockReturnValue(fileConfig);
		const timing = createTiming();
		const info = { name: "@halcyon/example", packageDirectory: "/repo/packages/example" };

		const { fileSystem } = createMemoryFileSystem();

		const result = await loadWorkspacePackagesAsync({
			cli: {},
			fileSystem,
			packageInfos: [info],
			timing,
		});

		expect(result).toStrictEqual([
			{
				descriptor: {
					name: "@halcyon/example",
					luauRoots: fileConfig.luauRoots,
					packageDirectory: "/repo/packages/example",
					rojoProjectPath: path.resolve("/repo/packages/example", "test.project.json"),
					rootDir: "/repo/packages/example",
				},
				info,
				pkgConfig: fileConfig,
			},
		]);
		expect(loadConfig).toHaveBeenCalledExactlyOnceWith(
			undefined,
			"/repo/packages/example",
			fileSystem,
		);
		expect(mergeCliWithConfig).toHaveBeenCalledExactlyOnceWith({}, fileConfig);
		expect(timing.profileAsync).toHaveBeenCalledOnce();
	});

	it("should preserve every explicit per-package coverage and Rojo override", async () => {
		expect.assertions(1);

		const packageConfig = makeConfig({
			collectCoverageFrom: ["src/**/*.ts"],
			coverageCache: !DEFAULT_CONFIG.coverageCache,
			coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
			coveragePathIgnorePatterns: ["generated/**"],
			luauRoots: ["src", "test"],
			rojoProject: "custom.project.json",
		});
		vi.mocked(mergeCliWithConfig).mockReturnValue(packageConfig);

		const [loaded] = await loadWorkspacePackagesAsync({
			cli: { collectCoverage: true },
			packageInfos: [{ name: "pkg", packageDirectory: "/repo/pkg" }],
			timing: createTiming(),
		});

		expect(loaded!.descriptor).toStrictEqual({
			name: "pkg",
			collectCoverageFrom: ["src/**/*.ts"],
			coverageCache: !DEFAULT_CONFIG.coverageCache,
			coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
			coveragePathIgnorePatterns: ["generated/**"],
			luauRoots: ["src", "test"],
			packageDirectory: "/repo/pkg",
			rojoProjectPath: path.resolve("/repo/pkg", "custom.project.json"),
			rootDir: "/repo/packages/example",
		});
	});

	it("should retain an explicitly empty collectCoverageFrom list", async () => {
		expect.assertions(1);

		vi.mocked(mergeCliWithConfig).mockReturnValue(makeConfig({ collectCoverageFrom: [] }));

		const [loaded] = await loadWorkspacePackagesAsync({
			cli: {},
			packageInfos: [{ name: "pkg", packageDirectory: "/repo/pkg" }],
			timing: createTiming(),
		});

		expect(loaded!.descriptor.collectCoverageFrom).toStrictEqual([]);
	});
});
