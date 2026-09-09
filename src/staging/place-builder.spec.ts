import { PLACE_CONTENT_ID_NAME, PLACE_CONTENT_ID_SERVICE } from "@isentinel/roblox-runner";
import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import process from "node:process";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { ageFile } from "../../test/mocks/aged-file.ts";
import type { MemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import {
	mountOf,
	poolKeyOf,
	staged,
	stagedProjectSchema,
} from "../../test/mocks/staged-project.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import { CODE_SPLIT_PASS_VERSION, splitCodeMounts } from "./code-split.ts";
import { PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import {
	buildCodeBundle,
	buildPlaceAsync,
	type UnwrappedBuildPlaceOptions,
} from "./place-builder.ts";
import { computePlaceInputsKeyAsync } from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import { SHARED_POOL_PASS_VERSION } from "./shared-pool.ts";
import type { PackageDescriptor, UnwrappedPackageDescriptor } from "./synthesizer.ts";
import { synthesize } from "./synthesizer.ts";

const PROJECT_FILE = "/cache/synth.project.json";
const PLACE_FILE = "/out/game.rbxl";
const PLACE_BYTES = "RBXL-BYTES";
const PACKAGE_DIR = "/pkg";
const PACKAGE_PROJECT = `${PACKAGE_DIR}/default.project.json`;
const MOUNT_DIR = "/repo/out";
const STAGE_DIR = "/repo/staged";
const NO_WRAP_PROJECT = JSON.stringify({ name: "synth", tree: { $path: MOUNT_DIR } });
const STAGED_PACKAGE_PROJECT = JSON.stringify({
	name: "synth",
	tree: { $className: "DataModel", Staged: { $className: "Folder", $path: STAGE_DIR } },
});
const STAND_IN_XML = [
	'<roblox version="4">',
	'  <Item class="StarterGui" referent="0">',
	"    <Properties>",
	'      <string name="Name">Gui</string>',
	"    </Properties>",
	"  </Item>",
	"</roblox>",
].join("\n");

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

function seed(files: Record<string, string>, bytes: string = PLACE_BYTES): Harness {
	const memory = createMemoryFileSystem(files);
	const execFile = vi.fn<RojoExec>((_file, args, _options, callback) => {
		const outputPath = args[3];
		memory.volume.writeFileSync(String(outputPath), bytes);
		callback(null, "", "");
	});
	return { ...memory, childProcess: fromAny({ execFile }), execFile };
}

function writtenProject({ volume }: Harness): typeof stagedProjectSchema.infer {
	return stagedProjectSchema.assert(
		JSON.parse(String(volume.readFileSync(PROJECT_FILE, "utf8"))),
	);
}

function makeUnwrappedDescriptor(): UnwrappedPackageDescriptor {
	return {
		packageDirectory: PACKAGE_DIR,
		rojoProjectPath: PACKAGE_PROJECT,
	};
}

function makeDescriptor(): PackageDescriptor {
	return {
		name: "pkg",
		...makeUnwrappedDescriptor(),
	};
}

function sharedDescriptor(name: string): PackageDescriptor {
	return {
		name,
		packageDirectory: `/pkg-${name}`,
		rojoProjectPath: `/pkg-${name}/default.project.json`,
	};
}

function seedSharedPackages(mounted: Record<string, string>, bytes?: string): Harness {
	return seed(
		{
			[sharedDescriptor("a").rojoProjectPath]: STAGED_PACKAGE_PROJECT,
			[sharedDescriptor("b").rojoProjectPath]: STAGED_PACKAGE_PROJECT,
			...mounted,
		},
		bytes,
	);
}

describe(buildPlaceAsync, () => {
	it("should return the built place path and its content hash", async () => {
		expect.assertions(1);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		const result = await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(result).toStrictEqual({
			hash: hashBuffer(Buffer.from(PLACE_BYTES)),
			path: PLACE_FILE,
		});
	});

	it("should stamp the content id into the place and record it on the artifact", async () => {
		expect.assertions(2);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		const result = await buildPlaceAsync({
			childProcess: rojo.childProcess,
			contentId: "deadbeef",
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Recorded on the artifact as well as stamped, because the host that
		// compares the two reads its half off the artifact.
		expect(writtenProject(rojo)).toMatchObject({
			tree: {
				[PLACE_CONTENT_ID_SERVICE]: {
					[PLACE_CONTENT_ID_NAME]: { $properties: { Value: "deadbeef" } },
				},
			},
		});
		expect(result.contentId).toBe("deadbeef");
	});

	it("should write the synthesized project to projectFile and build from it", async () => {
		expect.assertions(2);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(writtenProject(rojo)).toMatchObject({ name: "synth" });
		expect(rojo.execFile).toHaveBeenCalledWith(
			"rojo",
			["build", PROJECT_FILE, "-o", PLACE_FILE],
			{ windowsHide: true },
			expect.any(Function),
		);
	});

	it("should write $path entries relative to the project file", async () => {
		expect.assertions(1);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Rojo matches globIgnorePaths against the path as written, so an
		// absolute mount would leave every ignore pattern inert.
		expect(writtenProject(rojo)).toMatchObject({
			tree: { $path: normalizeWindowsPath(path.relative("/cache", MOUNT_DIR)) },
		});
	});

	it("should forward wrap and loadStringEnabled to synthesize", async () => {
		expect.assertions(2);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			loadStringEnabled: true,
			packages: [makeUnwrappedDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		const project = writtenProject(rojo);

		expect(project).toMatchObject({
			tree: { ServerScriptService: { $properties: { LoadStringEnabled: true } } },
		});
		expect(project.tree).not.toHaveProperty("ServerStorage");
	});

	it("should create the place file's parent directory before building", async () => {
		expect.assertions(1);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			placeFile: "/fresh/nested/game.rbxl",
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(rojo.volume.existsSync("/fresh/nested/game.rbxl")).toBeTrue();
	});

	it("should build a mount two packages share once, under the shared pool", async () => {
		expect.assertions(3);

		const rojo = seedSharedPackages({ [`${STAGE_DIR}/shared.luau`]: "return {}" });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [sharedDescriptor("a"), sharedDescriptor("b")],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const project = writtenProject(rojo);
		const keys = Object.keys(staged(project, "__shared")!).filter(
			(key) => key !== "$className",
		);

		expect(keys).toHaveLength(1);
		expect(poolKeyOf(staged(project, "a", "Staged"))).toBe(keys[0]!);
		expect(poolKeyOf(staged(project, "b", "Staged"))).toBe(keys[0]!);
	});

	it("should demote a pinned mount two packages share for both of them", async () => {
		expect.assertions(1);

		// The pool runs first, so the pinned-mount pass meets one node rather
		// than two and its single stand-in reaches every package. Running it
		// second, the pass skips the repeat as already scanned and leaves the
		// second package mounting the model the engine rejects.
		const rojo = seedSharedPackages(
			{ [`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }) },
			STAND_IN_XML,
		);

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [sharedDescriptor("a"), sharedDescriptor("b")],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const pool = staged(writtenProject(rojo), "__shared");

		expect(JSON.stringify(pool)).toContain("pinned-shadow");
	});
});

const CACHE_FILE = "/cache/place-cache.json";
const DIGEST_CACHE_FILE = "/cache/input-digests";

describe("place reuse", () => {
	function seedBuild(): Harness {
		const rojo = seed({
			[`${MOUNT_DIR}/init.luau`]: "print('hi')",
			[PACKAGE_PROJECT]: NO_WRAP_PROJECT,
		});
		// Back-dated so the digest cache is allowed to record a digest for it.
		ageFile(rojo.fileSystem, `${MOUNT_DIR}/init.luau`, 60);
		return rojo;
	}

	async function buildAsync(rojo: Harness, wrap = false): ReturnType<typeof buildPlaceAsync> {
		const options = {
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			reuse: {
				cacheFile: CACHE_FILE,
				digestCacheFile: DIGEST_CACHE_FILE,
				manifests: [],
				shadowRoots: [],
			},
		};

		return wrap
			? buildPlaceAsync({ ...options, packages: [makeDescriptor()], wrap })
			: buildPlaceAsync({ ...options, packages: [makeUnwrappedDescriptor()], wrap });
	}

	it("should not re-read an unchanged mount to decide on reuse", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);

		const readFile = vi.spyOn(rojo.fileSystem.promises, "readFile");
		await buildAsync(rojo);

		expect(readFile).not.toHaveBeenCalledWith(`${MOUNT_DIR}/init.luau`);
	});

	it("should skip the rojo build when nothing changed", async () => {
		expect.assertions(3);

		const rojo = seedBuild();
		const first = await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledOnce();

		const second = await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledOnce();
		expect(second).toStrictEqual(first);
	});

	it("should rebuild when a mounted input changed", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);
		rojo.volume.writeFileSync(`${MOUNT_DIR}/init.luau`, "print('edited')");
		await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place file is gone", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);
		rojo.volume.unlinkSync(PLACE_FILE);
		await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place no longer matches its recorded hash", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);
		// What an interrupted rojo build leaves: a place on disk that the
		// still-current record no longer describes.
		rojo.volume.writeFileSync(PLACE_FILE, "TRUNCATED");
		await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the inputs cannot be hashed", async () => {
		expect.assertions(2);

		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const rojo = seed({
			[PACKAGE_PROJECT]: JSON.stringify({
				name: "synth",
				servePort: 1.5,
				tree: { $path: MOUNT_DIR },
			}),
		});

		await buildAsync(rojo);
		await buildAsync(rojo);

		expect(write.mock.calls.map(String).join("")).toContain("could not hash rojo build inputs");
		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should skip the pinned-mount pass when nothing changed", async () => {
		expect.assertions(2);

		// A staged mount carrying a class the engine pins: the pinned-mount
		// pass spawns rojo once to build its Folder-rooted stand-in, on top of
		// the one spawn the place itself costs.
		const rojo = seed(
			{
				[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
				[PACKAGE_PROJECT]: STAGED_PACKAGE_PROJECT,
			},
			STAND_IN_XML,
		);

		await buildAsync(rojo, true);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);

		await buildAsync(rojo, true);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should fold the shared-pool pass version into the key", async () => {
		expect.assertions(2);

		const rojo = seedBuild();
		await buildAsync(rojo);
		const recorded = JSON.parse(String(rojo.volume.readFileSync(CACHE_FILE, "utf8")));
		const projectJson = synthesize({
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			wrap: false,
		});

		// The build's own inputs, keyed over a chosen set of passes. A pool
		// pass left out of the key would hand out a place built by its
		// previous rule.
		async function keyOverAsync(stagingVersions: Array<number>): Promise<string | undefined> {
			return computePlaceInputsKeyAsync({
				digestCacheFile: DIGEST_CACHE_FILE,
				fileSystem: rojo.fileSystem,
				manifests: [],
				projectFile: PROJECT_FILE,
				projectJson: relativizeProjectPaths(projectJson, path.dirname(PROJECT_FILE)),
				shadowRoots: [],
				stagingVersions,
			});
		}

		expect(recorded).not.toMatchObject({
			inputsKey: await keyOverAsync([PINNED_MOUNT_PASS_VERSION]),
		});
		expect(recorded).toMatchObject({
			inputsKey: await keyOverAsync([PINNED_MOUNT_PASS_VERSION, SHARED_POOL_PASS_VERSION]),
		});
	});

	it("should build every time when no reuse cache is configured", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		const options = {
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeUnwrappedDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		} satisfies UnwrappedBuildPlaceOptions;
		await buildPlaceAsync(options);
		await buildPlaceAsync(options);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});
});

const CODE_DIR = "/repo/code";
const OUT_DIR = `${CODE_DIR}/out`;
const MIXED_DIR = `${CODE_DIR}/mixed`;
/** Beside the place, named after it: `place-builder` derives this. */
const BUNDLE_FILE = path.join(path.dirname(PLACE_FILE), "game.code-bundle.json");
const bundleSchema = type({
	mounts: type({ dataModelPath: "string[]", root: { "source?": "string" } }).array(),
	version: "number",
});
/**
 * One package staging its compiled output, a directory inside the same Code
 * Root that holds something no task can construct, and a vendored tree outside
 * every Code Root.
 */
const BUNDLE_PACKAGE_PROJECT = JSON.stringify({
	name: "pkg",
	tree: {
		$className: "Folder",
		Include: { $path: "/repo/include" },
		Mixed: { $path: MIXED_DIR },
		Out: { $path: OUT_DIR },
	},
});

describe("code bundle", () => {
	function seedBundleBuild(): Harness {
		const rojo = seed({
			"/repo/include/runtime.luau": "return {}",
			[`${MIXED_DIR}/keep.luau`]: "return 'keep'",
			[`${MIXED_DIR}/notes.txt`]: "hello",
			[`${OUT_DIR}/init.luau`]: "return 1",
			[PACKAGE_PROJECT]: BUNDLE_PACKAGE_PROJECT,
		});
		// Back-dated so the digest cache is allowed to record a digest for them.
		for (const file of [
			"/repo/include/runtime.luau",
			`${MIXED_DIR}/keep.luau`,
			`${MIXED_DIR}/notes.txt`,
			`${OUT_DIR}/init.luau`,
		]) {
			ageFile(rojo.fileSystem, file, 60);
		}

		return rojo;
	}

	async function buildHarnessAsync(rojo: Harness): ReturnType<typeof buildPlaceAsync> {
		return buildPlaceAsync({
			childProcess: rojo.childProcess,
			codeRoots: [toPosixRoot(CODE_DIR)],
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			reuse: {
				cacheFile: CACHE_FILE,
				digestCacheFile: DIGEST_CACHE_FILE,
				manifests: [],
				shadowRoots: [],
			},
		});
	}

	/** The Code Bundle the build wrote, parsed. */
	function readBundle({ volume }: Harness): typeof bundleSchema.infer {
		return bundleSchema.assert(JSON.parse(String(volume.readFileSync(BUNDLE_FILE, "utf8"))));
	}

	it("should build a place that no longer mounts what the bundle carries", async () => {
		expect.assertions(3);

		const rojo = seedBundleBuild();
		await buildHarnessAsync(rojo);
		const project = writtenProject(rojo);

		expect(staged(project, "pkg", "Out")).toBeUndefined();
		// The two that could not travel are untouched, mount and all.
		expect(mountOf(project, "pkg", "Mixed")).toBe(
			normalizeWindowsPath(path.relative("/cache", MIXED_DIR)),
		);
		expect(mountOf(project, "pkg", "Include")).toBeDefined();
	});

	it("should write the bundle the harness no longer holds", async () => {
		expect.assertions(2);

		const rojo = seedBundleBuild();
		await buildHarnessAsync(rojo);
		const bundle = readBundle(rojo);

		expect(bundle.version).toBe(1);
		expect(bundle.mounts.map((mount) => mount.dataModelPath)).toStrictEqual([
			["ServerStorage", "__pkg_stage", "pkg", "Out"],
		]);
	});

	it("should report the bundle and the mounts that stayed to its caller", async () => {
		expect.assertions(1);

		const rojo = seedBundleBuild();
		const result = await buildHarnessAsync(rojo);

		expect(result.codeBundle).toStrictEqual({
			byteLength: Buffer.byteLength(
				String(rojo.volume.readFileSync(BUNDLE_FILE, "utf8")),
				"utf-8",
			),
			fileCount: 1,
			path: BUNDLE_FILE,
			// `Include` is not on the list: nothing about it was ever going to
			// travel, so naming it would be noise rather than a finding.
			stayedMounts: ["ServerStorage/__pkg_stage/pkg/Mixed"],
		});
	});

	it("should write the bundle on its own for a caller that built no place", async () => {
		expect.assertions(3);

		const rojo = seedBundleBuild();

		const bundle = buildCodeBundle({
			codeRoots: [toPosixRoot(CODE_DIR)],
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			// Named but never built at: it is what says where the bundle goes.
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		expect(bundle.fileCount).toBe(1);
		expect(readBundle(rojo).mounts.map((mount) => mount.dataModelPath)).toStrictEqual([
			["ServerStorage", "__pkg_stage", "pkg", "Out"],
		]);
		// The place is the caller's business: this writes the bundle and
		// nothing else, which is what lets a reused place still ship its code.
		expect(rojo.execFile).not.toHaveBeenCalled();
	});

	it("should reuse the harness across a code-only edit and rewrite the bundle", async () => {
		expect.assertions(2);

		const rojo = seedBundleBuild();
		await buildHarnessAsync(rojo);
		rojo.volume.writeFileSync(`${OUT_DIR}/init.luau`, "return 2");
		await buildHarnessAsync(rojo);

		// The harness never held that file, so its key cannot have moved — and
		// the bundle is written from disk either way, reuse or no reuse.
		expect(rojo.execFile).toHaveBeenCalledOnce();
		// `out/init.luau` promotes the mount itself, so the edit lands on the
		// mount root rather than on an entry beneath it.
		expect(readBundle(rojo).mounts[0]!.root.source).toBe("return 2");
	});

	it("should rebuild the harness when a mount that stayed changed", async () => {
		expect.assertions(1);

		const rojo = seedBundleBuild();
		await buildHarnessAsync(rojo);
		rojo.volume.writeFileSync(`${MIXED_DIR}/keep.luau`, "return 'edited'");
		await buildHarnessAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should fold the split pass version into the key", async () => {
		expect.assertions(2);

		const rojo = seedBundleBuild();
		await buildHarnessAsync(rojo);
		const recorded = JSON.parse(String(rojo.volume.readFileSync(CACHE_FILE, "utf8")));
		const { harnessProjectJson } = splitCodeMounts({
			codeRoots: [toPosixRoot(CODE_DIR)],
			fileSystem: rojo.fileSystem,
			projectDirectory: "/cache",
			projectJson: synthesize({
				fileSystem: rojo.fileSystem,
				packages: [makeDescriptor()],
			}),
		});

		// The harness's own inputs, keyed over a chosen set of passes. A split
		// left out of the key would hand out a harness hollowed by the
		// previous rule.
		async function keyOverAsync(stagingVersions: Array<number>): Promise<string | undefined> {
			return computePlaceInputsKeyAsync({
				digestCacheFile: DIGEST_CACHE_FILE,
				fileSystem: rojo.fileSystem,
				manifests: [],
				projectFile: PROJECT_FILE,
				projectJson: relativizeProjectPaths(harnessProjectJson, "/cache"),
				shadowRoots: [],
				stagingVersions,
			});
		}

		expect(recorded).not.toMatchObject({
			inputsKey: await keyOverAsync([PINNED_MOUNT_PASS_VERSION, SHARED_POOL_PASS_VERSION]),
		});
		expect(recorded).toMatchObject({
			inputsKey: await keyOverAsync([
				PINNED_MOUNT_PASS_VERSION,
				SHARED_POOL_PASS_VERSION,
				CODE_SPLIT_PASS_VERSION,
			]),
		});
	});

	it("should leave the code in the place when no bundle is asked for", async () => {
		expect.assertions(2);

		const rojo = seedBundleBuild();
		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		expect(mountOf(writtenProject(rojo), "pkg", "Out")).toBe(
			normalizeWindowsPath(path.relative("/cache", OUT_DIR)),
		);
		expect(rojo.volume.existsSync(BUNDLE_FILE)).toBeFalse();
	});

	it("should accept a bundle exactly at the binary-input cap", { timeout: 10_000 }, async () => {
		expect.assertions(2);

		const rojo = seedBundleBuild();
		const sourcePath = `${OUT_DIR}/boundary.luau`;
		rojo.fileSystem.writeFileSync(sourcePath, "");
		await buildHarnessAsync(rojo);
		const overhead = rojo.fileSystem.statSync(BUNDLE_FILE).size;
		const cap = 100 * 1024 * 1024;
		rojo.fileSystem.writeFileSync(sourcePath, `--${" ".repeat(cap - overhead - 2)}`);

		const result = await buildHarnessAsync(rojo);

		expect(result.codeBundle).toBeDefined();
		expect(rojo.fileSystem.statSync(BUNDLE_FILE).size).toBe(cap);
	});

	// Over the mutation run's 100ms budget by design: the only honest way to
	// prove a hundred-megabyte refusal is a hundred megabytes.
	it(
		"should refuse a bundle over the binary-input cap before building",
		{ timeout: 5000 },
		async () => {
			expect.assertions(2);

			const rojo = seedBundleBuild();
			// A sixth of the cap in control characters, which JSON escapes to six
			// bytes each: the smallest source that puts the payload over, and a
			// sixth of the bytes to move around getting there.
			rojo.fileSystem.writeFileSync(
				`${OUT_DIR}/huge.luau`,
				"\u0001".repeat(17 * 1024 * 1024),
			);

			await expect(buildHarnessAsync(rojo)).rejects.toMatchObject({
				// The way out rides with the refusal: a run that cannot ship
				// its code this way can still ship it inside the place.
				hint: expect.stringContaining("--no-binary-input"),
				message: expect.stringContaining(
					"over the 100.0 MB cap Open Cloud puts on a binary input",
				),
			});
			expect(rojo.execFile).not.toHaveBeenCalled();
		},
	);
});
