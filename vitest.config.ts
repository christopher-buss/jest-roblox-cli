import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

import { normalizeWindowsPath } from "./src/utils/normalize-windows-path.ts";

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

interface PackageJsonWithSourceExport {
	exports?: {
		"."?: null | { source?: string };
	};
}

// This package has fixture configs that import `@isentinel/jest-roblox`.
// Avoid the broad `source` condition here so those self-imports keep exercising
// the built package during coverage; alias only the workspace deps that need
// inline source for node-builtin mocks.
const requireFromConfig = createRequire(import.meta.url);

function sourceAlias(packageName: string) {
	const packageJsonPath = requireFromConfig.resolve(`${packageName}/package.json`);
	const packageRoot = dirname(packageJsonPath);
	const packageJson = requireFromConfig(packageJsonPath) as PackageJsonWithSourceExport;
	const packageExport = packageJson.exports?.["."];
	const sourceEntry =
		typeof packageExport === "object" && packageExport !== null
			? packageExport.source
			: undefined;

	if (typeof sourceEntry !== "string") {
		throw new Error(`${packageName} must expose exports["."].source for Vitest tests`);
	}

	return { find: packageName, replacement: resolve(packageRoot, sourceEntry) };
}

const workspaceSourceAliases = [
	sourceAlias("@isentinel/luau-ast"),
	sourceAlias("@isentinel/rojo-utils"),
	sourceAlias("@isentinel/roblox-runner"),
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
	const packageJson = requireFromConfig("./package.json") as PackageJsonWithSourceExport;
	const sourceEntry = packageJson.exports?.["."]?.source;
	if (typeof sourceEntry !== "string") {
		throw new Error('package.json must expose exports["."].source for integration tests');
	}

	// Canonicalize via the repo convention (backslashes → `/`, upper-case
	// drive letter) so jiti gets a stable module ID regardless of how the
	// drive-letter casing arrived from Node on Windows.
	return normalizeWindowsPath(resolve(import.meta.dirname, sourceEntry));
}

const jitiSourceAlias = JSON.stringify({ "@isentinel/jest-roblox": selfSourceEntry() });

export default defineConfig({
	plugins: [luauPlugin],
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
			{
				plugins: [luauPlugin],
				resolve: { alias: workspaceSourceAliases },
				test: {
					name: "unit",
					// `*.bench.ts` benchmarks (run via `vitest bench`) live
					// beside the unit specs. Scope them to this project so the
					// e2e/live projects — the latter has a network globalSetup —
					// never pick them up.
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
						// Config-loading integration tests run in the
						// `integration` project (no coverage) — see the
						// JITI_ALIAS note above.
						"test/integration/config/**",
						"test/integration/executor/**",
						"**/src/types/**",
						"./src/cli.ts",
						"**/*.luau",
					],
					include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
					restoreMocks: true,
					setupFiles,
					typecheck: {
						checker: "tsgo",
						enabled: true,
						include: ["src/**/*.spec-d.ts"],
						tsconfig: "./tsconfig.spec.json",
					},
					unstubEnvs: true,
				},
			},
			{
				plugins: [luauPlugin],
				resolve: { alias: workspaceSourceAliases },
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
						JITI_ALIAS: jitiSourceAlias,
					},
					include: [
						"test/integration/config/**/*.spec.ts",
						"test/integration/executor/**/*.spec.ts",
					],
					restoreMocks: true,
					setupFiles,
					unstubEnvs: true,
				},
			},
			{
				plugins: [luauPlugin],
				resolve: { alias: workspaceSourceAliases },
				test: {
					name: "e2e",
					// Benchmarks belong to the unit project only; opt this one
					// out so `vitest bench` never runs them here.
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
				plugins: [luauPlugin],
				resolve: { alias: workspaceSourceAliases },
				test: {
					name: "live",
					// Benchmarks belong to the unit project only; opt this one
					// out so `vitest bench` never triggers the network
					// globalSetup.
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
