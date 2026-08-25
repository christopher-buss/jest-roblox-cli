import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { TestProjectInlineConfiguration } from "vitest/config";
import { defaultExclude, defineConfig } from "vitest/config";

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

/**
 * The one boundary that decides which project an e2e spec joins. Specs under
 * here reach real Open Cloud and run in `live`; every other spec under
 * `test/e2e/` is deterministic and runs in `e2e`. Declared once and used by
 * both projects so the two globs cannot drift apart.
 */
const LIVE_DIRECTORY = "test/e2e/live";

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
 * The Vite-level options shared by the workspace and Stryker configs: the
 * `.luau` raw loader and the workspace source aliases. Inline projects inherit
 * these options from the workspace root.
 */
export const sharedViteOptions = {
	plugins: [luauPlugin],
	resolve: { alias: workspaceSourceAliases },
} satisfies TestProjectInlineConfiguration;

/**
 * The coverage-measured suite. Exported so `vitest.stryker.config.ts` can run
 * exactly this project — and only this one — without restating its settings.
 */
export const unitProject = {
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
				test: {
					name: "e2e",
					// Benchmarks belong to the unit project only, so leave
					// `e2e (bench)` with nothing to collect.
					benchmark: {
						include: [],
					},
					clearMocks: true,
					// A live-gated spec misfiled outside `LIVE_DIRECTORY` would
					// otherwise reach the real wire from here, because CI
					// exports the flag and the credentials for the whole `nx
					// affected` command. Blanking it makes that spec skip
					// instead. Nothing else reads it — `runCliAsync`'s allow-list
					// never forwards it to a child.
					env: {
						JEST_ROBLOX_LIVE: "",
					},
					// `*.spec.ts`, not `*.e2e.spec.ts`, so no file under
					// `test/e2e/` can miss both projects. The price is two
					// excludes: `fixtures/**` holds Jest-on-Roblox specs, which
					// are inputs rather than tests, and `defaultExclude` must be
					// spread back in rather than replaced — the live fixture's
					// `node_modules` symlinks this package onto itself, so
					// without `**/node_modules/**` the glob collects every spec
					// a second time through the loop.
					exclude: [...defaultExclude, `${LIVE_DIRECTORY}/**`, "test/e2e/fixtures/**"],
					// `createFixtureSandbox` tears its temp tree down in an
					// `onTestFinished` hook, and a `--coverage` run leaves a
					// whole instrumented shadow tree behind. Deleting that many
					// small files outruns the 10s default `hookTimeout` on
					// Windows once the workspace specs are competing for I/O —
					// which reads as a failure in a test that already passed.
					hookTimeout: 30_000,
					include: ["test/e2e/**/*.spec.ts"],
					restoreMocks: true,
					setupFiles,
					// The `--typecheckOnly` specs spawn a real tsgo build, which
					// is the slowest thing in this project by a wide margin and
					// scales with how many other files are running. Measured at
					// 14s idle and 38s with the rest of the project competing,
					// so 30s was a coin flip once the workspace specs moved in
					// here — and a timeout in one `it` corrupts the assertion
					// count of the next, so it surfaces as two unrelated-looking
					// failures. Same reason the integration project sits above
					// the default.
					testTimeout: 60_000,
					unstubEnvs: true,
				},
			},
			{
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
					// Files here run in parallel, and so do other checkouts
					// running against the same place: execution is pinned to
					// each run's uploaded version (no clobber), streaming keys
					// are per-run UUIDs, and each test builds its own temp
					// sandbox, so concurrent live runs do not collide. The
					// fixture compile is hoisted to the e2e-live-fixture target
					// so nothing races on out/.
					env: {
						// Concurrent runs across processes share one place's
						// per-minute upload quota, so a burst can 429. The
						// server's retry-after is short (~5-9s), so raise the
						// client retry budget to ride it out in-place instead
						// of failing (the CLI reads this for its OcaleRunner).
						JEST_ROBLOX_OCALE_MAX_RETRIES: "8",
					},
					globalSetup: ["./test/e2e/fixtures/live-place/global-setup.ts"],
					// Every spec that reaches real Open Cloud lives here and
					// nowhere else. Both projects glob on `LIVE_DIRECTORY` and
					// on the same `*.spec.ts` suffix, so the two halves cannot
					// drift into a gap where a file belongs to neither.
					include: [`${LIVE_DIRECTORY}/**/*.spec.ts`],
					pool: "forks",
					restoreMocks: true,
					// Live tests hit the real Open Cloud API; transient network
					// blips (latency, 5xx, OCALE rate limits) self-heal on a
					// retry instead of forcing a manual re-run. Scoped to
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
		watch: false,
	},
});
