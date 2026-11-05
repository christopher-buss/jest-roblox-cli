import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { fakeTimingCollector } from "#test/mocks/fake-timing-collector.ts";
import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { WorkspacePackageCoverage } from "../coverage-pipeline/workspace-prepare.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { PrepareCoverage } from "./coverage-attach.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PendingEntry } from "./pending-entry.ts";
import { stageWorkspacePlaceAsync } from "./place-staging.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { WorkspaceTestSelection } from "./test-selection.ts";

const WORKSPACE_ROOT = path.resolve("/workspace");
const CACHE_DIRECTORY = path.resolve("/cache");
const PACKAGE_NAME = "@scope/package";
const PACKAGE_DIR = path.resolve("/workspace/packages/package");
const PACKAGE_PROJECT = path.join(PACKAGE_DIR, "default.project.json");
const PLACE_BYTES = "RBXL-BYTES";
// memfs keys its volume by the POSIX spelling with the drive letter stripped.
const CACHE_KEY = "/cache";
const SHADOW_KEY = "/workspace/.jest-roblox/workspace/@scope-package/coverage";
/** Beside the place the run builds, named after it. */
const CODE_BUNDLE_KEY = `${CACHE_KEY}/synthesized.code-bundle.json`;

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

interface Harness extends MemoryFileSystem {
	childProcess: ChildProcessRunner;
	execFile: Mock<RojoExec>;
}

const PROJECT_JSON = JSON.stringify({
	name: "package",
	tree: {
		$className: "DataModel",
		ReplicatedStorage: { $className: "Folder", Pkg: { $path: "src" } },
	},
});

function makeProject(): ResolvedProjectConfig {
	return fromAny({
		config: {},
		displayName: "unit",
		rojoMounts: [{ dataModelPath: "ReplicatedStorage/Pkg", fsPath: "src" }],
		testMatch: ["**/*.spec"],
	});
}

function makeContext(project: ResolvedProjectConfig): PackageContext {
	return fromAny({
		cacheRoot: path.join(CACHE_DIRECTORY, "package"),
		descriptor: {
			name: PACKAGE_NAME,
			packageDirectory: PACKAGE_DIR,
			rojoProjectPath: PACKAGE_PROJECT,
			rootDir: PACKAGE_DIR,
		},
		info: { name: PACKAGE_NAME, packageDirectory: PACKAGE_DIR },
		pkgConfig: { ...createResolvedConfig(), collectCoverage: true, rootDir: PACKAGE_DIR },
		projects: [project],
	});
}

function makeLoaded(context: PackageContext): Array<LoadedPackage> {
	return [
		fromAny<LoadedPackage, unknown>({
			descriptor: context.descriptor,
			info: context.info,
			pkgConfig: context.pkgConfig,
		}),
	];
}

function makeSelection(
	context: PackageContext,
	project: ResolvedProjectConfig,
): WorkspaceTestSelection {
	return fromAny({
		filteredContexts: [context],
		pending: [
			fromAny<PendingEntry, unknown>({
				pkg: PACKAGE_NAME,
				project,
				projectConfig: context.pkgConfig,
			}),
		],
	});
}

function makeCoverage(): WorkspacePackageCoverage {
	return fromAny({
		coverageRoots: [],
		coverageSpine: [],
		manifest: {
			buildId: "build-1",
			files: {},
			generatedAt: "2026-01-01T00:00:00.000Z",
			nonInstrumentedFiles: {},
		},
		manifestPath: `${SHADOW_KEY}/coverage-manifest.json`,
		pkg: PACKAGE_NAME,
		rootDir: PACKAGE_DIR,
	});
}

function fakePrepareCoverage(coverage: WorkspacePackageCoverage): Mock<PrepareCoverage> {
	return vi.fn<PrepareCoverage>(() => [coverage]);
}

function seed(): Harness {
	const memory = createMemoryFileSystem({
		[PACKAGE_PROJECT]: PROJECT_JSON,
		[path.join(PACKAGE_DIR, "package.json")]: `{ "name": "${PACKAGE_NAME}" }`,
		[path.join(PACKAGE_DIR, "src/index.luau")]: "return 1\n",
	});
	const execFile = vi.fn<RojoExec>((...[, args, , callback]) => {
		memory.volume.writeFileSync(String(args[3]), PLACE_BYTES);
		callback(null, "", "");
	});
	return {
		...memory,
		childProcess: fromAny({ execFile }),
		execFile,
	};
}

describe(stageWorkspacePlaceAsync, () => {
	it("should build the shared place with stable cache paths and publish its manifests", async () => {
		expect.assertions(5);

		const { childProcess, execFile, fileSystem, volume } = seed();
		const project = makeProject();
		const context = makeContext(project);
		// The two staging phases each report their own span, and the caller
		// sums them: coverage, the stub sweep, the stub write, and the build.
		const timing = fakeTimingCollector(35);
		const coverage = makeCoverage();
		const prepareCoverage = fakePrepareCoverage(coverage);

		const result = await stageWorkspacePlaceAsync({
			cacheDirectory: CACHE_DIRECTORY,
			childProcess,
			fileSystem,
			loaded: makeLoaded(context),
			prepareCoverage,
			selection: makeSelection(context, project),
			timing,
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(result).toStrictEqual({
			// No Code Roots were asked for, so the place holds the code and
			// there is no bundle beside it.
			codeBundle: undefined,
			coverageByPackage: new Map([[PACKAGE_NAME, coverage]]),
			coverageMs: 35,
			placeFile: path.join(CACHE_DIRECTORY, "synthesized.rbxl"),
			stagingMs: 105,
		});
		expect(timing.profileTimedAsync).toHaveBeenCalledWith("rojoBuild", expect.any(Function));
		expect(volume.toJSON()).toContainKeys([
			`${CACHE_KEY}/synthesized.project.json`,
			`${CACHE_KEY}/synthesized.rbxl`,
			`${CACHE_KEY}/synthesized.place-cache.json`,
			`${CACHE_KEY}/synthesized.input-digests`,
			`${SHADOW_KEY}/build-manifest.json`,
		]);
		expect(execFile.mock.lastCall![1]).toContain(
			path.join(CACHE_DIRECTORY, "synthesized.project.json"),
		);
		expect(prepareCoverage).toHaveBeenCalledExactlyOnceWith({
			fileSystem,
			packages: [context.descriptor],
			timing,
			workspaceRoot: WORKSPACE_ROOT,
		});
	});

	it("should write a bundle beside the place when given Code Roots", async () => {
		expect.assertions(2);

		const { childProcess, fileSystem, volume } = seed();
		const project = makeProject();
		const context = makeContext(project);

		const result = await stageWorkspacePlaceAsync({
			cacheDirectory: CACHE_DIRECTORY,
			childProcess,
			// Everything a coverage run mounts sits under the workspace root —
			// the shadow the mounts were redirected onto included — so one root
			// covers the lot and nothing stays behind.
			codeRoots: [posixRoot(WORKSPACE_ROOT)],
			fileSystem,
			loaded: makeLoaded(context),
			prepareCoverage: fakePrepareCoverage(makeCoverage()),
			selection: makeSelection(context, project),
			timing: fakeTimingCollector(0),
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(volume.toJSON()).toContainKey(CODE_BUNDLE_KEY);
		// Carried back out, because only the run knows to hand it to a backend.
		expect(result.codeBundle).toMatchObject({
			path: path.join(CACHE_DIRECTORY, "synthesized.code-bundle.json"),
			stayedMounts: [],
		});
	});
});
