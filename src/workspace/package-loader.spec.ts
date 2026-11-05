import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { PackageConfigLoader } from "../config/loader.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { loadWorkspacePackagesAsync } from "./package-loader.ts";

const NO_SUCH_PACKAGE = path.join(import.meta.dirname, "no-such-package");

async function loadDefaultConfigAsync(): Promise<ResolvedConfig> {
	const [loaded] = await loadWorkspacePackagesAsync({
		cli: {},
		packageInfos: [{ name: "defaults", packageDirectory: NO_SUCH_PACKAGE }],
		timing: createTiming(),
	});
	return loaded!.pkgConfig;
}

const LOADED_DEFAULTS = await loadDefaultConfigAsync();

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...LOADED_DEFAULTS,
		// `std-env` settles when it loads, so the env-probed formatter default
		// differs between a developer machine and an agent one.
		formatters: ["default"],
		rootDir: "/repo/packages/example",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function loaderFor(config: ResolvedConfig): PackageConfigLoader {
	return vi.fn<PackageConfigLoader>(async () => config);
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
		const loadPackageConfig = loaderFor(fileConfig);
		const timing = createTiming();
		const info = { name: "@halcyon/example", packageDirectory: "/repo/packages/example" };

		const { fileSystem } = createMemoryFileSystem();

		const result = await loadWorkspacePackagesAsync({
			cli: { verbose: true },
			fileSystem,
			loadPackageConfig,
			packageInfos: [info],
			timing,
		});

		expect(result[0]).toStrictEqual({
			descriptor: {
				name: "@halcyon/example",
				luauRoots: fileConfig.luauRoots,
				packageDirectory: "/repo/packages/example",
				rojoProjectPath: path.resolve("/repo/packages/example", "test.project.json"),
				rootDir: "/repo/packages/example",
			},
			info,
			pkgConfig: expect.objectContaining({ rootDir: "/repo/packages/example" }),
		});
		expect(result[0]!.pkgConfig.verbose).toBeTrue();
		expect(loadPackageConfig).toHaveBeenCalledExactlyOnceWith({
			cwd: "/repo/packages/example",
			fileSystem,
		});
		expect(timing.profileAsync).toHaveBeenCalledExactlyOnceWith(
			"load-config:@halcyon/example",
			expect.any(Function),
		);
	});

	it("should preserve every explicit per-package coverage and Rojo override", async () => {
		expect.assertions(1);

		const packageConfig = makeConfig({
			collectCoverageFrom: ["src/**/*.ts"],
			coverageCache: !LOADED_DEFAULTS.coverageCache,
			coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
			coveragePathIgnorePatterns: ["generated/**"],
			luauRoots: ["src", "test"],
			rojoProject: "custom.project.json",
		});

		const [loaded] = await loadWorkspacePackagesAsync({
			cli: { collectCoverage: true },
			loadPackageConfig: loaderFor(packageConfig),
			packageInfos: [{ name: "pkg", packageDirectory: "/repo/pkg" }],
			timing: createTiming(),
		});

		expect(loaded!.descriptor).toStrictEqual({
			name: "pkg",
			collectCoverageFrom: ["src/**/*.ts"],
			coverageCache: !LOADED_DEFAULTS.coverageCache,
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

		const [loaded] = await loadWorkspacePackagesAsync({
			cli: {},
			loadPackageConfig: loaderFor(makeConfig({ collectCoverageFrom: [] })),
			packageInfos: [{ name: "pkg", packageDirectory: "/repo/pkg" }],
			timing: createTiming(),
		});

		expect(loaded!.descriptor.collectCoverageFrom).toStrictEqual([]);
	});

	it("should read the package's own config when no loader is supplied", async () => {
		expect.assertions(1);

		const packageDirectory = NO_SUCH_PACKAGE;

		const [loaded] = await loadWorkspacePackagesAsync({
			cli: {},
			packageInfos: [{ name: "pkg", packageDirectory }],
			timing: createTiming(),
		});

		expect(loaded!.descriptor).toStrictEqual({
			name: "pkg",
			luauRoots: undefined,
			packageDirectory,
			rojoProjectPath: path.resolve(packageDirectory, "test.project.json"),
			rootDir: path.resolve(packageDirectory),
		});
	});

	it("should leave descriptor.coveragePathIgnorePatterns undefined when the package config defaults", async () => {
		expect.assertions(1);

		const [loaded] = await loadWorkspacePackagesAsync({
			cli: { collectCoverage: true },
			loadPackageConfig: loaderFor(makeConfig({ collectCoverage: true })),
			packageInfos: [{ name: "pkg", packageDirectory: "/repo/pkg" }],
			timing: createTiming(),
		});

		expect(loaded!.descriptor.coveragePathIgnorePatterns).toBeUndefined();
	});
});
