import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MANIFEST_VERSION } from "#test/mocks/coverage-versions.ts";
import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath, posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { Instrumenter } from "../instrument/instrumenter.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ShadowTreeInputs } from "./shadow-tree.ts";
import { createCoverageManifest, prepareShadowTree } from "./shadow-tree.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/pkg");
const SHADOW_ROOT = path.resolve("/repo/.shadow");
const MANIFEST_PATH = path.join(SHADOW_ROOT, "coverage-manifest.json");

function seedRoots(volume: MemoryVolume, roots: Array<string>): void {
	for (const root of roots) {
		volume.mkdirSync(path.join(PACKAGE_DIRECTORY, root), { recursive: true });
		volume.writeFileSync(path.join(PACKAGE_DIRECTORY, root, "init.luau"), "local x = 1");
	}
}

function createInstrumenter() {
	return vi.fn<Instrumenter>(({ luauRoot }) => {
		const key = `${luauRoot}/init.luau`;
		return {
			[key]: {
				key,
				coverageMapPath: `${key}.cov-map.json`,
				instrumentedLuauPath: key,
				originalLuauPath: key,
				sourceHash: "hash",
				sourceMapPath: `${key}.map`,
				statementCount: 1,
			},
		};
	});
}

function inputsFor(
	fileSystem: FileSystem,
	{
		instrumenter = createInstrumenter(),
		roots,
	}: { instrumenter?: Instrumenter; roots: Array<string> },
): ShadowTreeInputs {
	const defaults = createResolvedConfig();
	return {
		fileSystem,
		instrumenter,
		manifestLabel: "Test manifest",
		manifestPath: MANIFEST_PATH,
		narrowed: roots.map((root) => {
			return { luauRoot: posixRoot(root), roots: [posixRoot(root)], spine: [] };
		}),
		settings: defaults,
		shadowRoot: SHADOW_ROOT,
		sourcePrefix: PACKAGE_DIRECTORY,
		universe: undefined,
	};
}

function prepareAndPublish(
	fileSystem: FileSystem,
	{ patch = {}, roots }: { patch?: Partial<CoverageManifest>; roots: Array<string> },
): void {
	const tree = prepareShadowTree(inputsFor(fileSystem, { roots }));
	fileSystem.mkdirSync(SHADOW_ROOT, { recursive: true });
	fileSystem.writeFileSync(
		MANIFEST_PATH,
		JSON.stringify({ ...createCoverageManifest(tree, { buildId: "b" }), ...patch }),
	);
}

describe(prepareShadowTree, () => {
	it("should key files under the source prefix and pair each root with its shadow", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedRoots(volume, ["out"]);
		const instrumenter = createInstrumenter();

		const tree = prepareShadowTree(inputsFor(fileSystem, { instrumenter, roots: ["out"] }));

		expect(Object.keys(tree.files)).toStrictEqual([
			`${posixPath(PACKAGE_DIRECTORY)}/out/init.luau`,
		]);
		expect(tree.coverageRoots).toStrictEqual([
			{ luauRoot: posixRoot("out"), shadowDir: posixPath(path.join(SHADOW_ROOT, "out")) },
		]);
		expect(tree.luauRoots).toStrictEqual([posixRoot("out")]);
	});

	it("should key files by the bare root when the prefix is empty", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync("out", { recursive: true });
		volume.writeFileSync("out/init.luau", "local x = 1");
		const instrumenter = createInstrumenter();

		const tree = prepareShadowTree({
			...inputsFor(fileSystem, { instrumenter, roots: ["out"] }),
			sourcePrefix: "",
		});

		expect(Object.keys(tree.files)).toStrictEqual(["out/init.luau"]);
	});

	it("should keep the prior tree when a root is added", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedRoots(volume, ["a", "b"]);
		prepareAndPublish(fileSystem, { roots: ["a"] });

		const tree = prepareShadowTree(inputsFor(fileSystem, { roots: ["a", "b"] }));

		expect(tree.isIncremental).toBeTrue();
	});

	it.for([
		["the cache is off", { settings: { ...createResolvedConfig(), coverageCache: false } }, {}],
		["another instrumenter wrote it", {}, { instrumenterVersion: -1 }],
		["another copy-ignore list built it", {}, { copyIgnoreHash: "other" }],
		[
			"another coverage universe built it",
			{ universe: { digest: "current", includes: () => true } },
			{ coverageUniverseHash: "previous" },
		],
	] as const)("should wipe the prior tree when %s", ([, inputs, manifestPatch]) => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedRoots(volume, ["a"]);
		prepareAndPublish(fileSystem, { patch: manifestPatch, roots: ["a"] });

		const tree = prepareShadowTree({ ...inputsFor(fileSystem, { roots: ["a"] }), ...inputs });

		expect(tree.isIncremental).toBeFalse();
	});

	it("should wipe the prior tree when a root is dropped", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedRoots(volume, ["a", "b"]);
		prepareAndPublish(fileSystem, { roots: ["a", "b"] });
		volume.writeFileSync(path.join(SHADOW_ROOT, "stale.luau"), "stale");

		const tree = prepareShadowTree(inputsFor(fileSystem, { roots: ["a"] }));

		expect(tree.isIncremental).toBeFalse();
		expect(volume.existsSync(path.join(SHADOW_ROOT, "stale.luau"))).toBeFalse();
	});
});

describe(createCoverageManifest, () => {
	it("should record the frame-relative roots and the build fields", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedRoots(volume, ["out"]);
		const tree = prepareShadowTree(inputsFor(fileSystem, { roots: ["out"] }));

		expect(
			createCoverageManifest(tree, {
				buildId: "b",
				placeFilePath: "place.rbxl",
				rojoInputsHash: "r",
			}),
		).toMatchObject({
			buildId: "b",
			luauRoots: ["out"],
			placeFilePath: "place.rbxl",
			rojoInputsHash: "r",
			shadowDir: posixPath(SHADOW_ROOT),
			version: MANIFEST_VERSION,
		});
	});
});
