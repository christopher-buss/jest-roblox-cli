import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import { computePlaceContentId } from "../coverage-pipeline/place-content-id.ts";
import {
	COVERAGE_BUILD_MANIFEST_PATH,
	COVERAGE_MANIFEST_PATH,
} from "../coverage-pipeline/prepare.ts";
import type { RunDispatch } from "../run.ts";
import type { RunSeams } from "../run/seams.ts";
import { nodeRunSeams } from "../run/seams.ts";
import type { MultiRunResult } from "../run/types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import { prepareArtifactsAsync } from "./prepare-artifacts.ts";

const COVERAGE_DIR = path.dirname(COVERAGE_BUILD_MANIFEST_PATH);
const CLEAN_PLACE_PATH = path.join(COVERAGE_DIR, "clean.rbxl");
const CLEAN_PROJECT_PATH = path.join(COVERAGE_DIR, "clean.project.json");
const PLACE_BYTES = "CLEAN-RBXL-BYTES";
const MOUNT_DATA_MODEL_PATH = "ReplicatedStorage/shared";
const ROJO_PROJECT = JSON.stringify({
	name: "test",
	tree: {
		$className: "DataModel",
		ReplicatedStorage: {
			$className: "ReplicatedStorage",
			shared: { $path: "out/shared" },
		},
	},
});

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

interface Harness {
	dispatch: RunDispatch;
	fileSystem: FileSystem;
	seams: RunSeams;
	volume: MemoryVolume;
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
		version: MANIFEST_VERSION,
	};
}

function makeArtifacts(overrides: Partial<CoverageArtifacts> = {}): CoverageArtifacts {
	return {
		buildId: "build-42",
		coveragePlace: COVERAGE_PLACE,
		files: { "out/init.luau": { sourceHash: "h" } },
		generatedAt: "2026-06-07T00:00:00.000Z",
		projects: [],
		rebuilt: true,
		...overrides,
	};
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function multiResult(overrides: Partial<MultiRunResult> = {}): MultiRunResult {
	return {
		coverageMs: 0,
		merged: {},
		mode: "multi",
		projectResults: [],
		stagingMs: 0,
		...overrides,
	};
}

function seed(
	manifest: CoverageManifest | undefined,
	result: MultiRunResult = multiResult({ coverageArtifacts: makeArtifacts() }),
): Harness {
	const files: Record<string, string> = {
		"/test/default.project.json": ROJO_PROJECT,
		"/test/out/shared/init.luau": "return {}",
	};
	if (manifest !== undefined) {
		files[COVERAGE_MANIFEST_PATH] = JSON.stringify(manifest);
	}

	const memory = createMemoryFileSystem(files);
	const execFile = vi.fn<RojoExec>((_file, args, _options, callback) => {
		memory.volume.writeFileSync(String(args[3]), PLACE_BYTES);
		callback(null, "", "");
	});
	const dispatch: RunDispatch = {
		buildImplicitProject: vi
			.fn<RunDispatch["buildImplicitProject"]>()
			.mockReturnValue(fromAny({ displayName: "implicit" })),
		loadRojoTree: vi
			.fn<RunDispatch["loadRojoTree"]>()
			.mockReturnValue(fromAny({ $className: "DataModel" })),
		runMultiProject: vi.fn<RunDispatch["runMultiProject"]>().mockResolvedValue(result),
		runResolvedProjects: vi.fn<RunDispatch["runResolvedProjects"]>().mockResolvedValue(result),
		runWorkspaceMode: vi.fn<RunDispatch["runWorkspaceMode"]>(),
	};
	const seams: RunSeams = {
		...nodeRunSeams(),
		childProcess: fromAny({ execFile }),
		resolveAllProjects: vi.fn<RunSeams["resolveAllProjects"]>().mockResolvedValue([]),
	};
	return { dispatch, fileSystem: memory.fileSystem, seams, volume: memory.volume };
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

function writtenCleanProject({ volume }: Harness): string {
	return String(volume.readFileSync(CLEAN_PROJECT_PATH, "utf8"));
}

function projectWithMount(): ResolvedProjectConfig {
	return fromAny({
		displayName: "c",
		rojoMounts: [{ dataModelPath: MOUNT_DATA_MODEL_PATH, fsPath: "out/shared" }],
	});
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
				contentId: computePlaceContentId(manifestWithFile()),
				hash: hashBuffer(Buffer.from(PLACE_BYTES)),
				path: CLEAN_PLACE_PATH,
			},
			coverageData: undefined,
			coverageManifestPath: COVERAGE_MANIFEST_PATH,
			coveragePlace: COVERAGE_PLACE,
			projects: [],
		});
		expect(bundle.coveragePlace).not.toBe(bundle.cleanPlace);
		expect(bundle.cleanPlace.hash).not.toBe(bundle.coveragePlace.hash);
		expect(bundle.buildId).toBe("build-42");
	});

	it("should build the Clean Place stamped with the covering set's id", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		// The id the coverage run's own file records digest to — the place has
		// to carry the identity of the build the collector read, and this is
		// where the two are tied together.
		expect(bundle.cleanPlace.contentId).toBe(computePlaceContentId(manifestWithFile()));
	});

	it("should surface the coverage manifest paths and an empty projects list", async () => {
		expect.assertions(3);

		const harness = seed(manifestWithFile());

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle.buildManifestPath).toBe(COVERAGE_BUILD_MANIFEST_PATH);
		expect(bundle.coverageManifestPath).toBe(COVERAGE_MANIFEST_PATH);
		expect(bundle.projects).toStrictEqual([]);
	});

	it("should surface the resolved projects from the coverage artifacts", async () => {
		expect.assertions(1);

		const project = {
			displayName: "client",
			projectDataModelPath: "ReplicatedStorage/client",
			setupFiles: [],
			setupFilesAfterEnv: [],
			testMatch: ["**/*.spec"],
		};
		const harness = seed(
			manifestWithFile(),
			multiResult({ coverageArtifacts: makeArtifacts({ projects: [project] }) }),
		);

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle.projects).toStrictEqual([project]);
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

		const harness = seed(
			manifestWithFile(),
			multiResult({
				coverageArtifacts: makeArtifacts(),
				merged: { coverageData: { "a.luau": { s: { "0": 1 } } } },
			}),
		);

		const bundle = await prepareArtifactsAsync(makeConfig(), harness);

		expect(bundle.coverageData).toStrictEqual({ "a.luau": { s: { "0": 1 } } });
	});

	it("should build the clean place without stub mounts in no-projects mode", async () => {
		expect.assertions(2);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig(), harness);

		expect(harness.seams.resolveAllProjects).not.toHaveBeenCalled();
		expect(writtenCleanProject(harness)).not.toContain("jest.config");
	});

	it("should build the clean place without stub mounts for an empty projects list", async () => {
		expect.assertions(2);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig({ projects: [] }), harness);

		expect(harness.seams.resolveAllProjects).not.toHaveBeenCalled();
		expect(writtenCleanProject(harness)).not.toContain("jest.config");
	});

	it("should build the clean place with stub mounts in multi mode", async () => {
		expect.assertions(2);

		const config = makeConfig({ projects: fromAny([{ test: { displayName: "c" } }]) });
		const harness = seed(
			manifestWithFile(),
			multiResult({
				coverageArtifacts: makeArtifacts(),
				merged: { coverageData: { "b.luau": { s: { "0": 1 } } } },
			}),
		);
		vi.mocked(harness.seams.resolveAllProjects).mockResolvedValue([projectWithMount()]);

		const bundle = await prepareArtifactsAsync(config, harness);

		expect(writtenCleanProject(harness)).toContain("jest.config");
		expect(bundle.coverageData).toStrictEqual({ "b.luau": { s: { "0": 1 } } });
	});

	it("should fold per-test attribution into the published coverage manifest", async () => {
		expect.assertions(3);

		const harness = seed(
			manifestWithFile(),
			multiResult({
				coverageArtifacts: makeArtifacts(),
				merged: { attribution: EXAMPLE_ATTRIBUTION },
			}),
		);

		await prepareArtifactsAsync(makeConfig(), harness);

		const written = readCoverageManifest(harness);

		expect(written.tests).toStrictEqual(EXAMPLE_ATTRIBUTION.tests);
		expect(written.files["out/init.luau"]!.coveringTestIds).toStrictEqual({ "1": ["t1"] });
		expect(written.files["out/init.luau"]!.staticStatementIds).toStrictEqual(["0"]);
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

		const merged = vi.mocked(harness.dispatch.runResolvedProjects).mock.calls[0]![1];

		expect(merged.collectPerTestCoverage).toBeTrue();
	});

	it("should collect coverage whatever the caller's config said", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile());

		await prepareArtifactsAsync(makeConfig({ collectCoverage: false }), harness);

		const merged = vi.mocked(harness.dispatch.runResolvedProjects).mock.calls[0]![1];

		expect(merged.collectCoverage).toBeTrue();
	});

	it("should throw when the coverage run produced no artifacts", async () => {
		expect.assertions(1);

		const harness = seed(manifestWithFile(), multiResult());

		await expect(prepareArtifactsAsync(makeConfig(), harness)).rejects.toThrow(/no artifacts/);
	});
});
