import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { recordingTimingCollector } from "#test/mocks/workspace-timing-recorder.ts";
import type { PackageConfig, PackageConfigLoader } from "../config/loader.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { loadPackageConfigsAsync, loadWorkspacePackages } from "./package-loader.ts";

function packageConfig(overrides: Partial<ResolvedConfig> = {}): PackageConfig {
	return {
		declared: {},
		resolved: createResolvedConfig({ rootDir: "/repo/packages/example", ...overrides }),
	};
}

describe(loadPackageConfigsAsync, () => {
	it("should load each package config once under its own span", async () => {
		expect.assertions(3);

		const config = packageConfig();
		const loadPackageConfig = vi.fn<PackageConfigLoader>(async () => config);
		const info = { name: "@halcyon/example", packageDirectory: "/repo/packages/example" };
		const { fileSystem } = createMemoryFileSystem();
		const childProcess = createLuteChildProcess({ version: "1.0.1" });
		const { collector, paths } = recordingTimingCollector();

		const packages = await loadPackageConfigsAsync({
			childProcess,
			fileSystem,
			loadPackageConfig,
			packageInfos: [info],
			timing: collector,
		});

		expect(packages).toStrictEqual([{ config, info }]);
		expect(loadPackageConfig).toHaveBeenCalledExactlyOnceWith({
			childProcess,
			cwd: "/repo/packages/example",
			fileSystem,
		});
		expect(paths).toStrictEqual([
			"loadPackages",
			"loadPackages > load-config:@halcyon/example",
		]);
	});
});

describe(loadWorkspacePackages, () => {
	it("should merge the CLI options and build a default descriptor", () => {
		expect.assertions(2);

		const config = packageConfig();
		const info = { name: "@halcyon/example", packageDirectory: "/repo/packages/example" };

		const [loaded] = loadWorkspacePackages({
			cli: { verbose: true },
			fileSystem: createMemoryFileSystem().fileSystem,
			packages: [{ config, info }],
		});

		expect(loaded!.descriptor).toStrictEqual({
			name: "@halcyon/example",
			luauRoots: undefined,
			packageDirectory: "/repo/packages/example",
			rojoProjectPath: path.resolve("/repo/packages/example", "test.project.json"),
		});
		expect(loaded!.pkgConfig.verbose).toBeTrue();
	});

	it("should carry the package Luau roots and Rojo project", () => {
		expect.assertions(1);

		const config = packageConfig({
			luauRoots: ["src", "test"],
			rojoProject: "custom.project.json",
		});

		const [loaded] = loadWorkspacePackages({
			cli: fromAny({}),
			fileSystem: createMemoryFileSystem().fileSystem,
			packages: [{ config, info: { name: "pkg", packageDirectory: "/repo/pkg" } }],
		});

		expect(loaded!.descriptor).toStrictEqual({
			name: "pkg",
			luauRoots: ["src", "test"],
			packageDirectory: "/repo/pkg",
			rojoProjectPath: path.resolve("/repo/pkg", "custom.project.json"),
		});
	});
});
