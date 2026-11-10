import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import type { AttributionResult } from "../attribution/attribution.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { BackendResult, DispatchBase } from "../backends/interface.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { RunSeams } from "../run/seams.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { prepareArtifactsAsync } from "./prepare-artifacts.ts";

const ROOT_DIR = "/test";
const COVERAGE_MANIFEST_PATH = path.resolve(
	ROOT_DIR,
	".jest-roblox/coverage/coverage-manifest.json",
);
const COVERAGE_BUILD_MANIFEST_PATH = path.resolve(
	ROOT_DIR,
	".jest-roblox/coverage/build-manifest.json",
);

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function contentIdOf({ files, nonInstrumentedFiles }: CoverageManifest): string {
	const lines = [
		...Object.entries(files).map(([key, record]) => `f\0${key}\0${record.sourceHash}`),
		...Object.entries(nonInstrumentedFiles).map(
			([key, record]) => `n\0${key}\0${record.sourceHash}`,
		),
	];
	return sha256(lines.sort().join("\0"));
}

const PLACE_DIR = path.resolve(ROOT_DIR, ".jest-roblox", "place");
const CLEAN_PLACE_PATH = path.join(PLACE_DIR, "clean.rbxl");
const CLEAN_PROJECT_PATH = path.join(PLACE_DIR, "clean.project.json");
const PLACE_BYTES = "CLEAN-RBXL-BYTES";

const SHARED = "shared";

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

interface Harness {
	fileSystem: FileSystem;
	seams: RunSeams;
	volume: MemoryVolume;
}

interface SeedOptions {
	declared?: Array<string>;
	results?: Array<Partial<ExecuteResult>>;
	specs?: boolean;
}

const COVERAGE_PLACE = { hash: "cov-hash", path: ".jest-roblox/coverage/game.rbxl" };

const EXAMPLE_ATTRIBUTION: AttributionResult = {
	coveringTestIds: { "out/init.luau": { "1": ["t1"] } },
	staticStatementIds: { "out/init.luau": ["0"] },
	tests: [
		{
			testCaseId: "adds",
			testFilePath: "out/m.spec.luau",
			testFileSourceHash: "h",
			testId: "t1",
		},
	],
};

function manifestWithFile(): CoverageManifest {
	return {
		buildId: "build-42",
		files: {
			"out/init.luau": {
				key: "out/init.luau",
				coverageMapPath: "out/init.luau.cov-map.json",
				instrumentedLuauPath: "out/init.luau",
				originalLuauPath: "out/init.luau",
				sourceHash: "h",
				sourceMapPath: "out/init.luau.map",
				statementCount: 1,
			},
		},
		generatedAt: "2026-06-07T00:00:00.000Z",
		instrumenterVersion: 2,
		luauRoots: ["out"],
		nonInstrumentedFiles: {},
		shadowDir: ".jest-roblox/coverage",
		version: 6,
	};
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		luauRoots: [`out/${SHARED}`],
		rootDir: ROOT_DIR,
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function declaredConfig(...names: Array<string>): ResolvedConfig {
	return makeConfig({
		projects: names.map((name) => fromAny({ test: { displayName: name } })),
	});
}

function declaredProject(name: string): ResolvedProjectConfig {
	return {
		config: makeConfig(),
		displayName: name,
		exclude: [],
		include: [`src/${name}/**/*.spec.ts`],
		outDir: `out/${name}`,
		projects: [`ReplicatedStorage/${name}`],
		rojoMounts: [{ dataModelPath: `ReplicatedStorage/${name}`, fsPath: `out/${name}` }],
		testMatch: ["**/*.spec"],
	};
}

function manifestProject(displayName: string, mount: string) {
	return {
		displayName,
		projectDataModelPath: `ReplicatedStorage/${mount}`,
		setupFiles: [],
		setupFilesAfterEnv: [],
		testMatch: ["**/*.spec"],
	};
}

function makeBackend(): Backend {
	return {
		closeAsync: vi.fn<NonNullable<Backend["closeAsync"]>>(),
		kind: "studio",
		runTestsAsync: vi.fn<(request: DispatchBase) => Promise<BackendResult>>(),
	};
}

function makeExecuteResult(overrides: Partial<ExecuteResult>): ExecuteResult {
	return {
		exitCode: 0,
		result: {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1000,
			success: true,
			testResults: [],
		},
		timing: { executionMs: 1, startTime: 1000, testsMs: 1, totalMs: 1, uploadMs: 0 },
		...overrides,
	};
}

function seedFiles(
	manifest: CoverageManifest | undefined,
	{ declared = [], specs = true }: SeedOptions,
): Record<string, string> {
	const names = [SHARED, ...declared];
	const mounts = Object.fromEntries(names.map((name) => [name, { $path: `out/${name}` }]));
	const files: Record<string, string> = {
		"/test/default.project.json": JSON.stringify({
			name: "test",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: { $className: "ReplicatedStorage", ...mounts },
			},
		}),
		"/test/tsconfig.json": "{}",
	};
	for (const name of names) {
		files[`/test/out/${name}/init.luau`] = "return {}";
		if (specs) {
			files[`/test/src/${name}/a.spec.ts`] = "";
		}
	}

	if (manifest !== undefined) {
		files[COVERAGE_MANIFEST_PATH] = JSON.stringify(manifest);
	}

	return files;
}

function seed(manifest: CoverageManifest | undefined, options: SeedOptions = {}): Harness {
	const memory = createMemoryFileSystem(seedFiles(manifest, options));
	const execFile = vi.fn<RojoExec>(
		writingRojoExec({ bytes: PLACE_BYTES, fileSystem: memory.volume }),
	);
	const results = options.results ?? [];
	const seams = createRunSeams({
		childProcess: fromAny({ execFile }),
		mapCoverage: vi.fn<RunSeams["mapCoverage"]>(() => fromAny({ files: {} })),
		openBackend: vi.fn<RunSeams["openBackend"]>().mockReturnValue(makeBackend()),
		prepareCoverage: vi.fn<RunSeams["prepareCoverage"]>().mockResolvedValue(
			fromAny({
				buildId: "build-42",
				coveragePlace: COVERAGE_PLACE,
				files: { "out/init.luau": { sourceHash: "h" } },
				instrumentMs: 0,
				manifest: { generatedAt: "2026-06-07T00:00:00.000Z" },
				placeFile: COVERAGE_PLACE.path,
				rebuilt: true,
				stagingMs: 0,
			}),
		),
		resolveAllProjects: vi
			.fn<RunSeams["resolveAllProjects"]>()
			.mockResolvedValue((options.declared ?? []).map(declaredProject)),
		runProjects: vi.fn<RunSeams["runProjects"]>(async ({ jobs }) => {
			return {
				backendTiming: { executionMs: 1, uploadMs: 0 },
				results: jobs.map((_job, jobIndex) => {
					return { ...makeExecuteResult(results[jobIndex] ?? {}), jobIndex };
				}),
			};
		}),
		tsconfigReader: () => {
			return fromAny({
				config: { compilerOptions: { outDir: "out", rootDir: "src" } },
				path: "/test/tsconfig.json",
			});
		},
	});
	return { fileSystem: memory.fileSystem, seams, volume: memory.volume };
}

function readBuildManifest({ volume }: Harness): {
	cleanPlace?: unknown;
	coveragePlace: unknown;
} {
	return fromAny(JSON.parse(String(volume.readFileSync(COVERAGE_BUILD_MANIFEST_PATH, "utf8"))));
}

function readCoverageManifest({ volume }: Harness): CoverageManifest {
	return fromAny(JSON.parse(String(volume.readFileSync(COVERAGE_MANIFEST_PATH, "utf8"))));
}

function writtenCleanProject({ volume }: Harness) {
	return JSON.parse(String(volume.readFileSync(CLEAN_PROJECT_PATH, "utf8")));
}

function prepareCoverageCall({ seams }: Harness): Parameters<RunSeams["prepareCoverage"]> {
	return vi.mocked(seams.prepareCoverage).mock.calls[0]!;
}

describe(prepareArtifactsAsync, () => {
	it("should return distinct clean and coverage places sharing one buildId", async () => {
		expect.assertions(4);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle).toStrictEqual({
			buildId: "build-42",
			buildManifestPath: COVERAGE_BUILD_MANIFEST_PATH,
			cleanPlace: {
				contentId: contentIdOf(manifestWithFile()),
				hash: sha256(Buffer.from(PLACE_BYTES)),
				path: CLEAN_PLACE_PATH,
			},
			coverageData: undefined,
			coverageManifestPath: COVERAGE_MANIFEST_PATH,
			coveragePlace: COVERAGE_PLACE,
			projects: [manifestProject("test", SHARED)],
		});
		expect(bundle.coveragePlace).not.toBe(bundle.cleanPlace);
		expect(bundle.cleanPlace.hash).not.toBe(bundle.coveragePlace.hash);
		expect(bundle.buildId).toBe("build-42");
	});

	it("should build the Clean Place in the place directory", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle.cleanPlace.path).toBe(CLEAN_PLACE_PATH);
	});

	it("should build the Clean Place stamped with the covering set's id", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		// The id the coverage run's own file records digest to — the place has
		// to carry the identity of the build the collector read, and this is
		// where the two are tied together.
		expect(bundle.cleanPlace.contentId).toBe(contentIdOf(manifestWithFile()));
	});

	it("should surface the coverage manifest paths", async () => {
		expect.assertions(2);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle.buildManifestPath).toBe(COVERAGE_BUILD_MANIFEST_PATH);
		expect(bundle.coverageManifestPath).toBe(COVERAGE_MANIFEST_PATH);
	});

	it("should surface the declared projects from the coverage artifacts", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile(), { declared: ["client"] });

		const bundle = await prepareArtifactsAsync(declaredConfig("client"), harness);

		expect(bundle.projects).toStrictEqual([manifestProject("client", "client")]);
	});

	it("should emit the build manifest once with both places", async () => {
		expect.assertions(2);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);
		const manifest = readBuildManifest(harness);

		expect(manifest.coveragePlace).toStrictEqual(COVERAGE_PLACE);
		expect(manifest.cleanPlace).toStrictEqual(bundle.cleanPlace);
	});

	it("should carry coverage data from a no-projects run", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile(), {
			results: [{ coverageData: { "a.luau": { s: { "0": 1 } } } }],
		});

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle.coverageData).toStrictEqual({ "a.luau": { s: { "0": 1 } } });
	});

	it.for([undefined, []])(
		"should build the clean place with the implicit project's stub mounts for projects=%j",
		async (projects) => {
			expect.assertions(3);

			const harness = seed(manifestWithFile());

			await prepareArtifactsAsync(makeConfig({ projects }), harness);

			expect(harness.seams.resolveAllProjects).not.toHaveBeenCalled();
			expect(writtenCleanProject(harness)).toHaveProperty([
				"tree",
				"ReplicatedStorage",
				SHARED,
				"jest.config",
			]);
			expect(writtenCleanProject(harness)).toHaveProperty([
				"tree",
				"ReplicatedStorage",
				SHARED,
				"$path",
			]);
		},
	);

	it("should build the clean place with stub mounts in multi mode", async () => {
		expect.assertions(2);

		const harness = seed(manifestWithFile(), {
			declared: ["c"],
			results: [{ coverageData: { "b.luau": { s: { "0": 1 } } } }],
		});

		const bundle = await prepareArtifactsAsync(declaredConfig("c"), harness);

		expect(writtenCleanProject(harness)).toHaveProperty([
			"tree",
			"ReplicatedStorage",
			"c",
			"jest.config",
		]);
		expect(bundle.coverageData).toStrictEqual({ "b.luau": { s: { "0": 1 } } });
	});

	it("should fold per-test attribution into the published coverage manifest", async () => {
		expect.assertions(3);

		const harness = seed(manifestWithFile(), {
			results: [{ attribution: EXAMPLE_ATTRIBUTION }],
		});

		await prepareArtifactsAsync(makeConfig(), harness);

		const written = readCoverageManifest(harness);

		expect(written.tests).toStrictEqual(EXAMPLE_ATTRIBUTION.tests);
		expect(written.files["out/init.luau"]!.coveringTestIds).toStrictEqual({ "1": ["t1"] });
		expect(written.files["out/init.luau"]!.staticStatementIds).toStrictEqual(["0"]);
	});

	it("should fold attribution across every project result", async () => {
		expect.assertions(2);

		const second: AttributionResult = {
			coveringTestIds: { "out/init.luau": { "1": ["t2"] } },
			staticStatementIds: { "out/init.luau": ["0"] },
			tests: [{ ...EXAMPLE_ATTRIBUTION.tests[0]!, testCaseId: "subtracts", testId: "t2" }],
		};
		const harness = seed(manifestWithFile(), {
			declared: ["p0", "p1", "p2"],
			results: [{ attribution: EXAMPLE_ATTRIBUTION }, {}, { attribution: second }],
		});

		await prepareArtifactsAsync(declaredConfig("p0", "p1", "p2"), harness);

		const written = readCoverageManifest(harness);

		expect(written.tests).toHaveLength(2);
		expect(written.files["out/init.luau"]!.coveringTestIds).toStrictEqual({
			"1": ["t1", "t2"],
		});
	});

	it("should leave the published coverage manifest alone when a run attributes nothing", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig(), harness);

		expect(readCoverageManifest(harness)).toStrictEqual(manifestWithFile());
	});

	it("should refuse to stamp a place when the coverage manifest cannot be read", async () => {
		expect.assertions(1);

		// The manifest is what the Place Content Id is taken over, so a bundle
		// built without it would carry a place proving less than it claims.
		const harness = seed(undefined);

		await expect(prepareArtifactsAsync(makeConfig(), harness)).rejects.toThrow(
			/could not read the coverage manifest/,
		);
	});

	it("should opt the coverage run into per-test attribution collection", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig(), harness);

		expect(prepareCoverageCall(harness)[0].collectPerTestCoverage).toBeTrue();
	});

	it("should collect coverage whatever the caller's config said", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig({ collectCoverage: false }), harness);

		expect(prepareCoverageCall(harness)[0].collectCoverage).toBeTrue();
	});

	it("should hand the caller's instrument universe to the coverage pass", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());
		const instrumentUniverse = { digest: "scope", includes: () => true };

		await prepareArtifactsAsync(makeConfig(), { ...harness, instrumentUniverse });

		expect(prepareCoverageCall(harness)[1]).toHaveProperty(
			"instrumentUniverse",
			instrumentUniverse,
		);
	});

	it("should hand the coverage pass no instrument universe when the caller gave none", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig(), harness);

		expect(prepareCoverageCall(harness)[1]).not.toHaveProperty("instrumentUniverse");
	});

	it("should throw when the coverage run produced no artifacts", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile(), { specs: false });

		await expect(prepareArtifactsAsync(makeConfig(), harness)).rejects.toThrow(/no artifacts/);
	});

	it("should flush the timing report when artifact production fails", async () => {
		expect.assertions(2);

		vi.stubEnv("TIMING", "1");
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const harness = seed(manifestWithFile(), { specs: false });

		await expect(prepareArtifactsAsync(makeConfig(), harness)).rejects.toThrow(/no artifacts/);

		expect(write.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("TOTAL (host)");
	});
});
