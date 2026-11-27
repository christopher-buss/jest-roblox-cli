import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { TestProjectInlineConfiguration, ViteUserConfig } from "vitest/config";
import { configDefaults, defaultExclude, defineConfig, mergeConfig } from "vitest/config";

import { QuotaSkipReporter } from "#test/setup/quota-skip-reporter.ts";
import { virtualModulesPlugin } from "./loaders/virtual-modules.mjs";
import { nodeFileSystem } from "./src/utils/file-system.ts";
import { normalizeWindowsPath } from "./src/utils/normalize-windows-path.ts";
import {
	NO_PROCESS_START_SETUP,
	sharedConfig,
	unitProject as sharedUnitProject,
} from "./vitest.shared.ts";

const luauPlugin = {
	name: "luau-raw",
	load(id: string) {
		if (id.endsWith(".lua")) {
			return "export default {};";
		}

		if (!id.endsWith(".luau")) {
			return;
		}

		const content = readFileSync(id, "utf-8");
		return `export default ${JSON.stringify(content)};`;
	},
};

const setupFiles = ["./test/setup/enable-colors.ts"];

const LIVE_DIRECTORY = "test/e2e/live";

const SANDBOX_EXCLUDE = ["**/.tmp", "**/.tmp/**"];

// Fixture configs import `@isentinel/jest-roblox`, so no broad `source`
// condition: those self-imports must exercise the built package.
export const baseConfig: ViteUserConfig = { ...sharedConfig, environments: {} };

// Reading goes through `readFileSync` because `require()` returns `any`, which
// `ts/no-unsafe-type-assertion` forbids casting.
const requireFromConfig = createRequire(import.meta.url);

function readSourceEntry(packageJsonPath: string, subpath: string): string | undefined {
	const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || !("exports" in parsed)) {
		return undefined;
	}

	const exportsField = parsed["exports"];
	if (
		typeof exportsField !== "object" ||
		exportsField === null ||
		Array.isArray(exportsField) ||
		!(subpath in exportsField)
	) {
		return undefined;
	}

	const subpathExport = exportsField[subpath];
	if (
		typeof subpathExport !== "object" ||
		subpathExport === null ||
		!("source" in subpathExport)
	) {
		return undefined;
	}

	return typeof subpathExport["source"] === "string" ? subpathExport["source"] : undefined;
}

function readExportSubpaths(packageJsonPath: string): Array<string> {
	const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || !("exports" in parsed)) {
		return [];
	}

	const exportsField = parsed["exports"];
	if (typeof exportsField !== "object" || exportsField === null) {
		return [];
	}

	return Object.keys(exportsField);
}

function sourceAliases(packageName: string) {
	const packageJsonPath = requireFromConfig.resolve(`${packageName}/package.json`);
	const aliases: Array<{ find: string; replacement: string }> = [];
	for (const subpath of readExportSubpaths(packageJsonPath)) {
		const sourceEntry = readSourceEntry(packageJsonPath, subpath);
		if (sourceEntry === undefined) {
			continue;
		}

		aliases.push({
			find: packageName + subpath.slice(1),
			replacement: resolve(dirname(packageJsonPath), sourceEntry),
		});
	}

	if (aliases.length === 0) {
		throw new Error(`${packageName} must expose exports["."].source for Vitest tests`);
	}

	return aliases.toSorted((left, right) => right.find.length - left.find.length);
}

const workspaceSourceAliases = [
	{
		find: "@isentinel/jest-roblox/api",
		replacement: resolve(import.meta.dirname, "src/api.ts"),
	},
	...sourceAliases("@isentinel/luau-ast"),
	...sourceAliases("@isentinel/rojo-utils"),
	...sourceAliases("@isentinel/roblox-runner"),
];

function selfSourceEntry(): string {
	const sourceEntry = readSourceEntry(resolve(import.meta.dirname, "package.json"), ".");
	if (sourceEntry === undefined) {
		throw new Error('package.json must expose exports["."].source for integration tests');
	}

	// Canonicalize via the repo convention (backslashes → `/`, upper-case
	// drive letter) so jiti gets a stable module ID regardless of how the
	// drive-letter casing arrived from Node on Windows.
	return normalizeWindowsPath(resolve(import.meta.dirname, sourceEntry));
}

const JITI_SOURCE_ALIAS = JSON.stringify({ "@isentinel/jest-roblox": selfSourceEntry() });

/**
 * The Vite-level options shared by the workspace and Stryker configs: the
 * `.luau` raw loader and the workspace source aliases. Inline projects inherit
 * these options from the workspace root.
 */
export const sharedViteOptions = {
	plugins: [virtualModulesPlugin(), luauPlugin],
	resolve: {
		alias: workspaceSourceAliases,
	},
} satisfies TestProjectInlineConfiguration;

/** The coverage-measured suite, which `vitest.stryker.config.ts` also runs. */
export const unitProject = {
	extends: true,
	test: {
		name: "unit",
		// Scoped here so the e2e/live projects never pick up benchmarks. `vitest
		// bench` names this one `unit (bench)`, which the `bench` package script
		// filters on.
		benchmark: {
			include: ["test/bench/**/*.bench.ts"],
		},
		deps: sharedUnitProject.test.deps,
		env: {
			GITHUB_ACTIONS: "",
		},
		exclude: [
			"src/**/__fixtures__/**",
			"test/fixtures/**",
			"test/e2e/**",
			// Integration tests run in the `integration` project
			// (no coverage). See the JITI_ALIAS note above.
			"test/integration/**",
			"test/luau/**",
		],
		include: [
			"src/**/*.spec.ts",
			"test/**/*.spec.ts",
			"scripts/**/*.spec.ts",
			"loaders/**/*.spec.ts",
		],
		provide: {
			installedFixtureRoot: resolve(import.meta.dirname, "test/e2e/fixtures/live-place"),
		},
		setupFiles: [...setupFiles, NO_PROCESS_START_SETUP],
	},
} satisfies TestProjectInlineConfiguration;

export default mergeConfig(
	baseConfig,
	defineConfig({
		...sharedViteOptions,
		test: {
			coverage: {
				exclude: [
					"src/**/*.spec.ts",
					"src/**/*.spec-d.ts",
					"src/**/*-types.ts",
					"src/**/*.d.ts",
					"src/**/__fixtures__/**",
					"bin/jest-roblox.js",
					"bin/sea-entry.ts",
					"scripts/stamp-plugin-version.run.ts",
				],
				include: [
					"src/**/*.ts",
					"scripts/sea-executable.ts",
					"scripts/stamp-plugin-version.ts",
					"loaders/*.mjs",
				],
			},
			projects: [
				{
					...unitProject,
					test: {
						...unitProject.test,
						maxWorkers: 4,
						sequence: {
							groupOrder: 1,
						},
					},
				},
				{
					extends: true,
					test: {
						name: "type",
						benchmark: {
							include: [],
						},
						include: [],
						setupFiles,
						// Resolves `tsconfig.spec.json`'s reference to
						// `tsconfig.lib.json` by building it; `--noEmit -p` reads
						// the reference's emitted declarations and fails TS6305.
						typecheck: {
							build: true,
							checker: "tsrs",
							enabled: true,
							include: ["src/**/*.spec-d.ts", "loaders/**/*.spec-d.ts"],
							only: true,
							tsconfig: "./tsconfig.spec.json",
						},
					},
				},
				{
					extends: true,
					test: {
						name: "integration",
						// Benchmarks belong to the unit project only.
						benchmark: {
							include: [],
						},
						// Resolve the package's own fixture imports to source
						// so this project runs build-free (no `dist`). See the
						// JITI_ALIAS note above for why these tests are
						// isolated from coverage.
						env: {
							GITHUB_ACTIONS: "",
							JITI_ALIAS: JITI_SOURCE_ALIAS,
						},
						include: ["test/integration/**/*.spec.ts"],
						setupFiles,
						// Fixture-sandbox pipelines and specs that spawn a real
						// tsgo cross the 5s default under parallel hook load.
						testTimeout: 15_000,
					},
				},
				{
					extends: true,
					test: {
						name: "luau",
						benchmark: {
							include: [],
						},
						include: ["test/luau/**/*.spec.ts"],
						setupFiles,
						// Each spec blocks on a synchronous Luau runtime spawn,
						// whose wall time tracks machine load, not harness work.
						testTimeout: 30_000,
					},
				},
				{
					extends: true,
					test: {
						name: "e2e",
						// Benchmarks belong to the unit project only, so leave
						// `e2e (bench)` with nothing to collect.
						benchmark: {
							include: [],
						},
						// A live-gated spec misfiled outside `LIVE_DIRECTORY`
						// would otherwise reach the real wire from here, because
						// CI exports the flag and the credentials for the whole
						// `nx affected` command. Blanking it makes that spec skip
						// instead. Nothing else reads it: `runCliAsync`'s
						// allow-list never forwards it to a child.
						env: {
							JEST_ROBLOX_LIVE: "",
						},
						// Every `*.spec.ts` under `test/e2e/`, so no file misses
						// both projects. `fixtures/**` holds Jest-on-Roblox
						// inputs, and the live fixture's `node_modules` symlinks
						// this package onto itself, so `defaultExclude` must be
						// spread back in.
						exclude: [
							...defaultExclude,
							...SANDBOX_EXCLUDE,
							`${LIVE_DIRECTORY}/**`,
							"test/e2e/fixtures/**",
						],
						globalSetup: ["./test/helpers/e2e/global-setup.ts"],
						// `createFixtureSandbox` deletes its temp tree in
						// `onTestFinished`, and a `--coverage` shadow tree
						// outruns the default `hookTimeout` on Windows under I/O
						// contention.
						hookTimeout: 30_000,
						include: ["test/e2e/**/*.spec.ts"],
						setupFiles,
						// The `--typecheckOnly` specs spawn a real tsgo build
						// that scales with concurrent load, and a timeout in one
						// `it` corrupts the next one's assertion count. Same
						// reason the integration project sits above the default.
						testTimeout: 60_000,
					},
				},
				{
					extends: true,
					test: {
						name: "live",
						// Benchmarks belong to the unit project only. This leaves
						// `live (bench)` empty but still derived, so the `bench`
						// script names `unit (bench)` to skip the network setup.
						benchmark: {
							include: [],
						},
						// Every spec that reaches real Open Cloud lives here and
						// nowhere else; the `e2e` project globs the complement.
						include: [`${LIVE_DIRECTORY}/**/*.spec.ts`],
						// Concurrent live runs must not collide, whether they are
						// files here or other checkouts on the same place:
						// version identity guards execution, streaming keys are
						// per-run UUIDs, and each test builds its own sandbox.
						// Nothing may serialize this project to keep that true.
						pool: "forks",
						// Exercise recovery without retrying failed assertions.
						retry: 0,
						setupFiles,
						// Generous budget: a heavily-throttled upload can wait
						// through several ~7s retry-after delays before landing.
						testTimeout: 120_000,
					},
				},
			],
			reporters: [...configDefaults.reporters, new QuotaSkipReporter(nodeFileSystem)],
		},
	}),
);
