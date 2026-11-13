import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { TestProjectInlineConfiguration } from "vitest/config";
import { configDefaults, defaultExclude, defineConfig } from "vitest/config";

import { QuotaSkipReporter } from "#test/setup/quota-skip-reporter.ts";
import { virtualModulesPlugin } from "./loaders/virtual-modules.mjs";
import { nodeFileSystem } from "./src/utils/file-system.ts";
import { normalizeWindowsPath } from "./src/utils/normalize-windows-path.ts";
import { NO_PROCESS_START_SETUP, unitProject as sharedUnitProject } from "./vitest.shared.ts";

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

const setupFiles = ["./test/setup/enable-colors.ts", "./test/setup/jest-extended.ts"];

const projectTestDefaults = {
	clearMocks: true,
	restoreMocks: true,
	setupFiles,
	unstubEnvs: true,
};

/**
 * The one boundary that decides which project an e2e spec joins. Specs under
 * here reach real Open Cloud and run in `live`; every other spec under
 * `test/e2e/` is deterministic and runs in `e2e`. Declared once and used by
 * both projects so the two globs cannot drift apart.
 */
const LIVE_DIRECTORY = "test/e2e/live";

/**
 * The fixture sandbox root (see `test/harness/sandbox-root.ts`) holds copies
 * of Roblox fixtures, spec files included, and an interrupted run leaves one
 * behind. Every project that can glob into it subtracts it.
 *
 * Two patterns, because they do different jobs: the deep form is what stops a
 * file being collected, and the bare directory form is what makes the walker
 * skip the subtree instead of testing every file inside it.
 */
const SANDBOX_EXCLUDE = ["**/.tmp", "**/.tmp/**"];

// This package has fixture configs that import `@isentinel/jest-roblox`.
// Avoid the broad `source` condition here so those self-imports keep exercising
// the built package during coverage; alias only the workspace deps that need
// inline source for node-builtin mocks.
//
// `createRequire` earns its keep for `.resolve()` only. Mapping a bare
// `<pkg>/package.json` specifier to a path needs CJS resolution. Reading the
// file goes through `readFileSync`, because `require()` returns `any` and
// casting it back to a shape is what `ts/no-unsafe-type-assertion` forbids.
const requireFromConfig = createRequire(import.meta.url);

/**
 * Digs `exports[<subpath>].source` out of a package.json, narrowing as it
 * goes.
 * @param packageJsonPath - Absolute path of a package manifest.
 * @param subpath - Export subpath.
 * @returns The `source` entry, or `undefined`.
 */
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

/**
 * Reads the export subpaths a package.json declares.
 * @param packageJsonPath - Absolute path of a package manifest.
 * @returns Keys of the manifest `exports` map.
 */
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

/**
 * One alias per source-conditioned export subpath, longest specifier first so
 * `<pkg>/parser` wins over the bare `<pkg>` prefix.
 * @param packageName - Package to alias.
 * @returns Aliases from specifier to source entry.
 */
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

/**
 * The `config`/`executor` integration tests load a `jest.config.ts` fixture
 * through the real config loader (c12 → jiti). The fixture imports
 * `@isentinel/jest-roblox`, and that load happens inside jiti's own resolver
 * (not Vitest's module graph), so the `resolve.alias` above does not reach it
 * and plain resolution lands on `dist/index.mjs`, forcing a prior `build`.
 * Point jiti at the package's own `source` export via its `JITI_ALIAS` env
 * contract so the fixture load resolves to source, keeping `test` build-free.
 *
 * These tests live in a dedicated `integration` project run WITHOUT coverage,
 * kept out of the coverage-measured `unit` project on purpose: jiti executes
 * the package's real source files in-process, and `@vitest/coverage-v8`'s
 * process-wide V8 data then attributes jiti's import-only execution (module
 * top level ran, but the functions were never called) to those same `src`
 * files, shadowing the genuine `unit` coverage down from 100%. A separate
 * no-coverage run sidesteps the collision entirely.
 * @returns Absolute path of this package's `source` entry.
 */
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
	resolve: { alias: workspaceSourceAliases },
} satisfies TestProjectInlineConfiguration;

/** The coverage-measured suite, which `vitest.stryker.config.ts` also runs. */
export const unitProject = {
	test: {
		...projectTestDefaults,
		name: "unit",
		// `test/bench/*.bench.ts` benchmarks belong to this project. Scope
		// them to this project so the e2e/live projects (the latter
		// has a network globalSetup) never pick them up. `vitest
		// bench` derives a separate project per entry, so this one's
		// benchmarks run as `unit (bench)`; that is the name the
		// `bench` package script filters on.
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
		// Vitest clears the mock registry and the module cache between files
		// only when `isolate` is true.
		isolate: false,
		provide: {
			installedFixtureRoot: resolve(import.meta.dirname, "test/e2e/fixtures/live-place"),
		},
		setupFiles: [...setupFiles, NO_PROCESS_START_SETUP],
	},
} satisfies TestProjectInlineConfiguration;

export default defineConfig({
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
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			"**/fixtures/**",
			"**/__fixtures__/**",
			"**/pnpm-lock.yaml",
			"**/test/setup/**",
			"**/tsconfig*.json",
			"**/vitest.shared.ts",
		],
		projects: [
			{
				...unitProject,
				test: { ...unitProject.test, maxWorkers: 4, sequence: { groupOrder: 1 } },
			},
			{
				test: {
					...projectTestDefaults,
					name: "type",
					benchmark: {
						include: [],
					},
					include: [],
					// Resolves `tsconfig.spec.json`'s reference to
					// `tsconfig.lib.json` by building it; `--noEmit -p` reads
					// the reference's emitted declarations and fails TS6305.
					typecheck: {
						build: true,
						checker: "tsc",
						enabled: true,
						include: ["src/**/*.spec-d.ts", "loaders/**/*.spec-d.ts"],
						only: true,
						tsconfig: "./tsconfig.spec.json",
					},
				},
			},
			{
				test: {
					...projectTestDefaults,
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
					// Fixture-sandbox pipelines and specs that spawn a real
					// tsgo cross the 5s default under parallel hook load.
					testTimeout: 15_000,
				},
			},
			{
				test: {
					...projectTestDefaults,
					name: "luau",
					benchmark: {
						include: [],
					},
					include: ["test/luau/**/*.spec.ts"],
					// Each spec blocks on a synchronous Luau runtime spawn,
					// whose wall time tracks machine load, not harness work.
					testTimeout: 30_000,
				},
			},
			{
				test: {
					...projectTestDefaults,
					name: "e2e",
					// Benchmarks belong to the unit project only, so leave
					// `e2e (bench)` with nothing to collect.
					benchmark: {
						include: [],
					},
					// A live-gated spec misfiled outside `LIVE_DIRECTORY` would
					// otherwise reach the real wire from here, because CI
					// exports the flag and the credentials for the whole `nx
					// affected` command. Blanking it makes that spec skip
					// instead. Nothing else reads it: `runCliAsync`'s allow-list
					// never forwards it to a child.
					env: {
						JEST_ROBLOX_LIVE: "",
					},
					// Every `*.spec.ts` under `test/e2e/`, so no file there
					// can miss both projects. The price is two
					// excludes of its own: `fixtures/**` holds Jest-on-Roblox
					// specs, which are inputs rather than tests, and
					// `defaultExclude` must be spread back in rather than
					// replaced. The live fixture's `node_modules` symlinks this
					// package onto itself, so without `**/node_modules/**` the
					// glob collects every spec a second time through the loop.
					exclude: [
						...defaultExclude,
						...SANDBOX_EXCLUDE,
						`${LIVE_DIRECTORY}/**`,
						"test/e2e/fixtures/**",
					],
					globalSetup: ["./test/e2e/global-setup.ts"],
					// `createFixtureSandbox` tears its temp tree down in an
					// `onTestFinished` hook, and a `--coverage` run leaves a
					// whole instrumented shadow tree behind. Deleting that many
					// small files outruns the 10s default `hookTimeout` on
					// Windows once the workspace specs are competing for I/O,
					// which reads as a failure in a test that already passed.
					hookTimeout: 30_000,
					include: ["test/e2e/**/*.spec.ts"],
					// The `--typecheckOnly` specs spawn a real tsgo build, which
					// is the slowest thing in this project by a wide margin and
					// scales with how many other files are running. Measured at
					// 14s idle and 38s with the rest of the project competing,
					// so 30s was a coin flip once the workspace specs moved in
					// here, and a timeout in one `it` corrupts the assertion
					// count of the next, so it surfaces as two unrelated-looking
					// failures. Same reason the integration project sits above
					// the default.
					testTimeout: 60_000,
				},
			},
			{
				test: {
					...projectTestDefaults,
					name: "live",
					// Benchmarks belong to the unit project only. This leaves
					// `live (bench)` empty but still derived, so the `bench`
					// script names `unit (bench)` to skip the network setup.
					benchmark: {
						include: [],
					},
					// Concurrent live runs must not collide, whether they are
					// files here or other checkouts on the same place: version
					// identity guards execution, streaming keys are per-run
					// UUIDs, and each test builds its own sandbox. Nothing may
					// serialize this project to keep that true.
					globalSetup: ["./test/e2e/fixtures/live-place/global-setup.ts"],
					// Every spec that reaches real Open Cloud lives here and
					// nowhere else; the `e2e` project globs the complement.
					include: [`${LIVE_DIRECTORY}/**/*.spec.ts`],
					pool: "forks",
					// Exercise recovery without retrying failed assertions.
					retry: 0,
					// Generous budget: a heavily-throttled upload can wait
					// through several ~7s retry-after delays before landing.
					testTimeout: 120_000,
				},
			},
		],
		reporters: ["default", new QuotaSkipReporter(nodeFileSystem)],
		watch: false,
	},
});
