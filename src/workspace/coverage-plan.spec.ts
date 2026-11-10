import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { buildWorkspaceCoveragePlan } from "./coverage-plan.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { PendingEntry } from "./test-selection.ts";

function loadedPackage(name: string, overrides: Partial<ResolvedConfig> = {}): LoadedPackage {
	return fromAny({
		descriptor: {
			name,
			luauRoots: ["src"],
			packageDirectory: `/packages/${name}`,
			rojoProjectPath: `/packages/${name}/default.project.json`,
		},
		info: { name },
		pkgConfig: createResolvedConfig({ rootDir: `/packages/${name}`, ...overrides }),
	});
}

function context(name: string, collectCoverage: boolean): PackageContext {
	return fromAny({ info: { name }, pkgConfig: { collectCoverage } });
}

function pendingEntry(name: string): PendingEntry {
	return fromAny({ job: { pkg: name } });
}

describe(buildWorkspaceCoveragePlan, () => {
	it("should instrument only loaded packages with pending jobs that opted in", () => {
		expect.assertions(1);

		const result = buildWorkspaceCoveragePlan({
			contexts: [
				context("selected", true),
				context("empty", true),
				context("opted-out", false),
				context("unloaded", true),
			],
			loaded: [loadedPackage("empty"), loadedPackage("opted-out"), loadedPackage("selected")],
			pending: [
				pendingEntry("selected"),
				pendingEntry("selected"),
				pendingEntry("opted-out"),
				pendingEntry("unloaded"),
			],
		});

		expect(result.packages.map((entry) => entry.name)).toStrictEqual(["selected"]);
	});

	it("should retain descriptor roots and resolved coverage defaults", () => {
		expect.assertions(1);

		const result = buildWorkspaceCoveragePlan({
			contexts: [context("selected", true)],
			loaded: [loadedPackage("selected")],
			pending: [pendingEntry("selected")],
		});

		expect(result.packages).toStrictEqual([
			{
				name: "selected",
				collectCoverageFrom: undefined,
				coverageCache: true,
				coverageCopyIgnorePatterns: ["**/*.d.ts", "**/*.d.ts.map", "**/*.luau.map"],
				coveragePathIgnorePatterns: [
					"**/*.spec.lua",
					"**/*.spec.luau",
					"**/*.test.lua",
					"**/*.test.luau",
					"**/node_modules/**",
					"**/rbxts_include/**",
				],
				luauRoots: ["src"],
				packageDirectory: "/packages/selected",
				rojoProjectPath: "/packages/selected/default.project.json",
				rootDir: "/packages/selected",
			},
		]);
	});

	it("should carry explicit coverage settings without changing the loaded package", () => {
		expect.assertions(2);

		const loaded = loadedPackage("selected", {
			collectCoverageFrom: ["src/**/*.ts"],
			coverageCache: false,
			coverageCopyIgnorePatterns: ["**/assets/**"],
			coveragePathIgnorePatterns: ["**/vendor/**"],
		});
		const original = structuredClone(loaded);
		const result = buildWorkspaceCoveragePlan({
			contexts: [context("selected", true)],
			loaded: [loaded],
			pending: [pendingEntry("selected")],
		});

		expect(result.packages[0]).toMatchObject({
			collectCoverageFrom: ["src/**/*.ts"],
			coverageCache: false,
			coverageCopyIgnorePatterns: ["**/assets/**"],
			coveragePathIgnorePatterns: ["**/vendor/**"],
		});
		expect(loaded).toStrictEqual(original);
	});
});
