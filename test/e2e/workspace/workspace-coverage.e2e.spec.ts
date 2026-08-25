import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "../cli/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	readJsonSync,
	rojoOnPath,
	runCliAsync,
} from "../cli/helpers.ts";

// Regression: `--workspace --coverage` against a package whose rojo
// `$path` mounts a directory holding BOTH `*.spec.luau` and non-spec helpers
// (e.g. `out-test/src/init.luau` next to `out-test/src/nested.spec.luau`).
// Pre-fix, `containsLuauFiles` made the dir a coverage root via the helper,
// the synthesizer redirected `$path` to the shadow, and the instrumenter
// filtered specs out — the shadow held only the instrumented helper and
// testMatch returned zero matches.
//
// All other workspace e2e tests run without `--coverage`, and the only other
// coverage e2e (`test/e2e/live/pipeline.e2e.spec.ts`) is
// `JEST_ROBLOX_LIVE`-gated. The bug lived squarely in the intersection of those
// missing axes.

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
const RUN_TIMEOUT_MS = 60_000;

// Only the field these regressions read — the manifest's full schema lives in
// `src/coverage-pipeline/manifest.ts` and is validated by the CLI itself.
const manifestFilesSchema = type({ files: "object" });

/** What a case here varies; everything else is held fixed. */
interface VendoredMountOverrides {
	/**
	 * Dropped from the emitted config when omitted. One case needs it absent,
	 * to prove `coveragePathIgnorePatterns` narrows the universe on its own
	 * rather than riding on the `luauRoots` short-circuit.
	 */
	luauRoots?: Array<string>;
	/** Folded into `test:`. */
	test?: {
		collectCoverageFrom?: Array<string>;
		coveragePathIgnorePatterns?: Array<string>;
	};
}

function readManifestFileKeys(manifestPath: string): Array<string> {
	const manifest = manifestFilesSchema.assert(readJsonSync(manifestPath));
	return Object.keys(manifest.files);
}

/**
 * Overwrite the vendored-mount package's config, keeping its rojo project and
 * its single Luau project and folding in whatever coverage knob the case under
 * test is about. Written from an object rather than hand-indented lines so the
 * differing key is the only thing a reader has to find.
 */
function writeVendoredMountConfig(sandbox: string, overrides: VendoredMountOverrides): void {
	const config = {
		...(overrides.luauRoots === undefined ? {} : { luauRoots: overrides.luauRoots }),
		rojoProject: "test.project.json",
		test: {
			passWithNoTests: true,
			projects: [
				{
					test: {
						displayName: "@e2e/vendored-mount",
						include: ["src/**/*.spec.luau"],
					},
				},
			],
			...overrides.test,
		},
	};
	const serialized = JSON.stringify(config, undefined, "\t");
	fs.writeFileSync(
		path.join(sandbox, "packages/vendored-mount/jest.config.ts"),
		`export default ${serialized};\n`,
	);
}

describe("workspace coverage — $path mounts specs alongside helpers", () => {
	it.skipIf(!rojoOnPath())(
		"should preserve spec files in the shadow and reach backend dispatch",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/nested",
					project: "@e2e/nested",
				},
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/nested", "--coverage", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			// Direct evidence the fix is in place: the cpSync into the shadow
			// dir copied the spec through. Pre-fix the shadow held only the
			// instrumented helper (`init.luau`), no `.spec.luau`.
			const shadowSpecPath = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-nested/coverage/out-test/src/nested.spec.luau",
			);

			expect(fs.existsSync(shadowSpecPath)).toBeTrue();

			// Guard against silent short-circuits — `passWithNoTests` on the
			// nested fixture would let zero-discovery pass even with the bug,
			// so we pin that the place was actually built and dispatched.
			expect(server.uploadCount).toBe(1);
			expect(server.requests).toHaveLength(1);
		},
		RUN_TIMEOUT_MS + 5000,
	);
});

// `collectCoverageFrom` decides what gets probes, not just what the report
// keeps: the probe counts for everything else still rode home in the task's
// 4 MiB return envelope. A file outside the globs must reach the shadow
// verbatim — dropping it instead would break the place, and probing it anyway
// would put the payload back.
describe("workspace coverage — collectCoverageFrom scopes instrumentation", () => {
	it.skipIf(!rojoOnPath())(
		"should mirror an out-of-universe file verbatim and leave it out of the manifest",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			const extraSource = "return 2\n";
			fs.writeFileSync(
				path.join(sandbox, "packages/vendored-mount/src/extra.luau"),
				extraSource,
			);
			writeVendoredMountConfig(sandbox, {
				luauRoots: ["src"],
				test: { collectCoverageFrom: ["packages/vendored-mount/src/init.luau"] },
			});

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/vendored-mount",
					project: "@e2e/vendored-mount",
				},
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/vendored-mount",
					"--coverage",
					"--backend",
					"open-cloud",
				],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const shadowRoot = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-vendored-mount/coverage",
			);
			const shadowExtra = path.join(shadowRoot, "src/extra.luau");

			expect(fs.existsSync(shadowExtra)).toBeTrue();
			// Byte-identical is the evidence: an instrumented copy carries a
			// probe preamble, so equality means no probes were inserted.
			expect(fs.readFileSync(shadowExtra, "utf-8")).toBe(extraSource);

			const manifestFileKeys = readManifestFileKeys(
				path.join(shadowRoot, "coverage-manifest.json"),
			);

			expect(manifestFileKeys.some((key) => key.endsWith("/src/init.luau"))).toBeTrue();
			expect(manifestFileKeys.some((key) => key.endsWith("/src/extra.luau"))).toBeFalse();
		},
		RUN_TIMEOUT_MS + 5000,
	);
});

// Regression: `--workspace --coverage` against a package whose rojo
// `test.project.json` mounts multiple `$path` entries (e.g. `src/` PLUS a
// vendored `Packages/` dir). Pre-fix, `discoverPackageLuauRoots` walked every
// `collectPaths` entry and instrumented every mounted directory — the per-pkg
// `luauRoots: ["src"]` was honored only in single mode, not workspace mode.
// The per-pkg `coveragePathIgnorePatterns` was likewise ignored because
// `prepareWorkspaceCoverage` read the matcher from the workspace-root config,
// never the merged pkgConfig.
//
// Both regression cases below assert on the shape of the per-package shadow
// directory after a CLI run: the user's source root must be instrumented; the
// vendored mount must not appear under the shadow.

describe("workspace coverage — multi-$path rojo tree honors per-pkg luauRoots", () => {
	it.skipIf(!rojoOnPath())(
		"should instrument only the luauRoot-listed mounts, skipping vendored $path dirs",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/vendored-mount",
					project: "@e2e/vendored-mount",
				},
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/vendored-mount",
					"--coverage",
					"--backend",
					"open-cloud",
				],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const shadowRoot = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-vendored-mount/coverage",
			);

			expect(fs.existsSync(path.join(shadowRoot, "src/init.luau"))).toBeTrue();
			expect(fs.existsSync(path.join(shadowRoot, "vendored-packages"))).toBeFalse();

			const manifestFileKeys = readManifestFileKeys(
				path.join(shadowRoot, "coverage-manifest.json"),
			);

			expect(manifestFileKeys.some((key) => key.includes("/vendored-packages/"))).toBeFalse();
			expect(server.uploadCount).toBe(1);
		},
		RUN_TIMEOUT_MS + 5000,
	);

	it.skipIf(!rojoOnPath())(
		"should respect per-package coveragePathIgnorePatterns over workspace defaults",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			// Swap the fixture's luauRoots config for a
			// coveragePathIgnorePatterns config so this case exercises the OTHER
			// half of the per-pkg config plumbing. Both paths (luauRoots
			// short-circuit vs. the matchesIgnored filter) flow through
			// `prepareWorkspaceCoverage` independently; a regression in either is
			// silent without coverage on both axes.
			writeVendoredMountConfig(sandbox, {
				test: { coveragePathIgnorePatterns: ["**/vendored-packages/**"] },
			});

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/vendored-mount",
					project: "@e2e/vendored-mount",
				},
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/vendored-mount",
					"--coverage",
					"--backend",
					"open-cloud",
				],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const shadowRoot = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-vendored-mount/coverage",
			);

			expect(fs.existsSync(path.join(shadowRoot, "src/init.luau"))).toBeTrue();
			expect(fs.existsSync(path.join(shadowRoot, "vendored-packages"))).toBeFalse();

			const manifestFileKeys = readManifestFileKeys(
				path.join(shadowRoot, "coverage-manifest.json"),
			);

			expect(manifestFileKeys.some((key) => key.includes("/vendored-packages/"))).toBeFalse();
			expect(server.uploadCount).toBe(1);
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
