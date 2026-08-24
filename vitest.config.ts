import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { TestProjectInlineConfiguration } from "vitest/config";
import { defineConfig } from "vitest/config";

const DRIVE_LETTER_START_REGEX = /^[A-Za-z]:\//;

function normalizeWindowsPath(input = ""): string {
	if (!input) {
		return input;
	}

	return input
		.replace(/\\/g, "/")
		.replace(DRIVE_LETTER_START_REGEX, (driveLetterMatch) => driveLetterMatch.toUpperCase());
}

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

// This package has fixture configs that import `@isentinel/jest-roblox`.
// Avoid the broad `source` condition here so those self-imports keep exercising
// the built package during coverage; alias only the workspace deps that need
// inline source for node-builtin mocks.
//
// `createRequire` earns its keep for `.resolve()` only — mapping a bare
// `<pkg>/package.json` specifier to a path needs CJS resolution. Reading the
// file goes through `readFileSync`, because `require()` returns `any` and
// casting it back to a shape is what `ts/no-unsafe-type-assertion` forbids.
const requireFromConfig = createRequire(import.meta.url);

/**
 * Digs `exports[<subpath>].source` out of a package.json, narrowing as it
 * goes.
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

/** Reads the export subpaths a package.json declares. */
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
	...sourceAliases("@isentinel/luau-ast"),
	...sourceAliases("@isentinel/rojo-utils"),
	...sourceAliases("@isentinel/roblox-runner"),
];

// The `config`/`executor` integration tests load a `jest.config.ts` fixture
// through the real config loader (c12 → jiti). The fixture imports
// `@isentinel/jest-roblox`, and that load happens inside jiti's own resolver —
// not Vitest's module graph — so the `resolve.alias` above does not reach it
// and plain resolution lands on `dist/index.mjs`, forcing a prior `build`.
// Point jiti at the package's own `source` export via its `JITI_ALIAS` env
// contract so the fixture load resolves to source, keeping `test` build-free.
//
// These tests live in a dedicated `integration` project run WITHOUT coverage,
// kept out of the coverage-measured `unit` project on purpose: jiti executes
// the package's real source files in-process, and `@vitest/coverage-v8`'s
// process-wide V8 data then attributes jiti's import-only execution (module
// top level ran, but the functions were never called) to those same `src`
// files, shadowing the genuine `unit` coverage down from 100%. A separate
// no-coverage run sidesteps the collision entirely.
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
 * The Vite-level options every project needs: the `.luau` raw loader and the
 * workspace source aliases. Spread into each project rather than declared once
 * on the root, because an inline project still inherits nothing from it —
 * Vitest 5 documents `extends` as defaulting to `true`, but 5.0.0-beta.7 has
 * yet to flip it, so an absent `extends` resolves to `false`. Once it flips,
 * the root declaration alone suffices and the spreads can go.
 */
const sharedViteOptions = {
	plugins: [luauPlugin],
	resolve: { alias: workspaceSourceAliases },
} satisfies TestProjectInlineConfiguration;

/**
 * The coverage-measured suite. Exported so `vitest.stryker.config.ts` can run
 * exactly this project — and only this one — without restating its settings.
 */
export const unitProject = {
	...sharedViteOptions,
	test: {
		name: "unit",
		// `*.bench.ts` benchmarks live beside the unit specs. Scope
		// them to this project so the e2e/live projects — the latter
		// has a network globalSetup — never pick them up. `vitest
		// bench` derives a separate project per entry, so this one's
		// benchmarks run as `unit (bench)`; that is the name the
		// `bench` package script filters on.
		benchmark: {
			include: ["src/**/*.bench.ts"],
		},
		clearMocks: true,
		env: {
			GITHUB_ACTIONS: "",
		},
		exclude: [
			"src/**/__fixtures__/**",
			"test/fixtures/**",
			"test/e2e/**",
			// Integration tests run in the `integration` project
			// (no coverage) — see the JITI_ALIAS note above.
			"test/integration/**",
			"test/**/*.integration.spec.ts",
			"**/src/types/**",
			"./src/cli.ts",
			"**/*.luau",
		],
		include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
		restoreMocks: true,
		setupFiles,
		typecheck: {
			// Resolves `tsconfig.spec.json`'s reference to
			// `tsconfig.lib.json` by building it. Without this the checker
			// runs `--noEmit -p`, which reads the reference's emitted
			// declarations and fails TS6305 until some earlier
			// `tsgo --build` has produced them — which is what this
			// target used to inline.
			build: true,
			checker: "tsgo",
			enabled: true,
			include: ["src/**/*.spec-d.ts"],
			tsconfig: "./tsconfig.spec.json",
		},
		unstubEnvs: true,
	},
} satisfies TestProjectInlineConfiguration;

export default defineConfig({
	...sharedViteOptions,
	test: {
		coverage: {
			exclude: [
				"dist/**",
				"packages/**",
				"src/**/*.bench.ts",
				"src/**/*.luau",
				"src/**/*.spec-d.ts",
				"test/e2e/**",
				"test/mocks/**",
				"package.json",
			],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		projects: [
			unitProject,
			{
				...sharedViteOptions,
				test: {
					name: "integration",
					// Benchmarks belong to the unit project only.
					benchmark: {
						include: [],
					},
					clearMocks: true,
					// Resolve the package's own fixture imports to source
					// so this project runs build-free (no `dist`). See the
					// JITI_ALIAS note above for why these tests are
					// isolated from coverage.
					env: {
						GITHUB_ACTIONS: "",
						JITI_ALIAS: JITI_SOURCE_ALIAS,
					},
					include: ["test/integration/**/*.spec.ts", "test/**/*.integration.spec.ts"],
					restoreMocks: true,
					setupFiles,
					// Fixture-sandbox pipelines and specs that spawn a real
					// tsgo cross the 5s default under parallel hook load.
					testTimeout: 15_000,
					unstubEnvs: true,
				},
			},
			{
				...sharedViteOptions,
				test: {
					name: "e2e",
					// Benchmarks belong to the unit project only, so leave
					// `e2e (bench)` with nothing to collect.
					benchmark: {
						include: [],
					},
					clearMocks: true,
					include: ["test/e2e/cli/**/*.e2e.spec.ts"],
					restoreMocks: true,
					setupFiles,
					testTimeout: 30_000,
					unstubEnvs: true,
				},
			},
			{
				...sharedViteOptions,
				test: {
					name: "live",
					// Benchmarks belong to the unit project only, so leave
					// `live (bench)` with nothing to collect. Note this alone
					// no longer keeps the network globalSetup out of a bare
					// `vitest bench` — the derived project exists either way —
					// which is why the `bench` script names `unit (bench)`.
					benchmark: {
						include: [],
					},
					clearMocks: true,
					// Files in a shard run in parallel: execution is
					// pinned to each run's uploaded version (no clobber),
					// streaming keys are per-run UUIDs, and each test uses
					// its own temp sandbox, so concurrent live runs do not
					// collide. Shards run in parallel too (nx); the fixture
					// compile is hoisted to the e2e-live-fixture target so
					// parallel shards never race on out/.
					env: {
						// Concurrent runs across processes share one place's
						// per-minute upload quota, so a burst can 429. The
						// server's retry-after is short (~5-9s), so raise the
						// client retry budget to ride it out in-place instead
						// of failing (the CLI reads this for its OcaleRunner).
						JEST_ROBLOX_OCALE_MAX_RETRIES: "8",
					},
					globalSetup: ["./test/e2e/fixtures/live-place/global-setup.ts"],
					include: [
						"test/e2e/contract/**/*.spec.ts",
						"test/e2e/project/**/*.e2e.spec.ts",
						"test/e2e/workspace/**/*.e2e.spec.ts",
					],
					pool: "forks",
					restoreMocks: true,
					// Live tests hit the real Open Cloud API; transient network
					// blips (latency, 5xx, OCALE rate limits) self-heal on a
					// retry instead of forcing a manual shard re-run. Scoped to
					// `live` only — `unit`/`integration`/`e2e` stay at 0 so real
					// failures surface immediately.
					retry: 2,
					setupFiles,
					// Generous budget: a heavily-throttled upload can wait
					// through several ~7s retry-after delays before landing.
					testTimeout: 120_000,
					unstubEnvs: true,
				},
			},
		],
	},
});
