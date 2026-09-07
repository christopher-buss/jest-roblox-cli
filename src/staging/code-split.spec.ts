/* eslint-disable unicorn/no-keyword-prefix -- `className` is the Code Bundle's own key, which the Luau rebuild reads by name. */
import { type } from "arktype";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import type { MemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import {
	mountOf,
	seed,
	staged,
	stagedProject,
	stagedProjectSchema,
} from "../../test/mocks/staged-project.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import { splitCodeMounts } from "./code-split.ts";

const PROJECT_DIR = path.resolve("/cache");
/** The Code Root: where the run's compiled output lives. */
const OUT = path.resolve("/repo/out");
/** Outside every Code Root — the vendored tree a harness keeps serving. */
const INCLUDE = path.resolve("/repo/include");

const bundleSchema = type({
	mounts: type({
		dataModelPath: "string[]",
		entries: type({ "className": "string", "path": "string", "source?": "string" }).array(),
		merge: "boolean",
		root: { "className": "string", "source?": "string" },
	}).array(),
	version: "number",
});

type Bundle = typeof bundleSchema.infer;
type BundleMount = Bundle["mounts"][number];

function split(
	fileSystem: MemoryFileSystem["fileSystem"],
	projectJson: string,
	codeRoots: Array<PosixRoot> = [toPosixRoot(OUT)],
): {
	bundle: Bundle;
	fileCount: number;
	harness: typeof stagedProjectSchema.infer;
	stayed: Array<string>;
} {
	const result = splitCodeMounts({
		codeRoots,
		fileSystem,
		projectDirectory: PROJECT_DIR,
		projectJson,
	});
	return {
		bundle: bundleSchema.assert(JSON.parse(result.bundleJson)),
		fileCount: result.fileCount,
		harness: stagedProjectSchema.assert(JSON.parse(result.harnessProjectJson)),
		stayed: result.stayedMounts,
	};
}

/** The one mount a single-mount project produced. */
function onlyMount(bundle: Bundle): BundleMount {
	assert(bundle.mounts.length === 1, `expected one mount, got ${String(bundle.mounts.length)}`);
	return bundle.mounts[0]!;
}

/** The entry the bundle carries at an instance path. */
function entryAt(mount: BundleMount, instancePath: string): BundleMount["entries"][number] {
	return mount.entries.find((candidate) => candidate.path === instancePath)!;
}

/** One package staging a single node under `ServerStorage.__pkg_stage`. */
function stagingProject(node: RojoTreeNode, globIgnorePaths?: Array<string>): string {
	return stagedProject({ pkg: { $className: "Folder", ...node } }, globIgnorePaths);
}

describe(splitCodeMounts, () => {
	it("should carry a mounted directory's scripts as the classes rojo gives them", () => {
		expect.assertions(4);

		const { fileSystem } = seed({
			[`${OUT}/client.client.luau`]: "print('c')",
			[`${OUT}/server.server.lua`]: "print('s')",
			[`${OUT}/test.spec.luau`]: "return {}",
		});

		const mount = onlyMount(split(fileSystem, stagingProject({ Out: { $path: OUT } })).bundle);

		expect(mount.dataModelPath).toStrictEqual(["ServerStorage", "__pkg_stage", "pkg", "Out"]);
		// The stem is kept whole, so `test.spec.luau` is still what a compiled
		// `TS.import` asks for by name.
		expect(entryAt(mount, "test.spec")).toStrictEqual({
			className: "ModuleScript",
			path: "test.spec",
			source: "return {}",
		});
		expect(entryAt(mount, "client")).toMatchObject({ className: "LocalScript" });
		expect(entryAt(mount, "server")).toMatchObject({ className: "Script" });
	});

	it("should promote a directory its init file classes", () => {
		expect.assertions(3);

		const { fileSystem } = seed({
			[`${OUT}/init.luau`]: "return 1",
			[`${OUT}/nested/init.server.luau`]: "return 2",
			[`${OUT}/nested/leaf.luau`]: "return 3",
		});

		const mount = onlyMount(split(fileSystem, stagingProject({ Out: { $path: OUT } })).bundle);

		expect(mount.root).toStrictEqual({ className: "ModuleScript", source: "return 1" });
		expect(entryAt(mount, "nested")).toStrictEqual({
			className: "Script",
			path: "nested",
			source: "return 2",
		});
		// The promoting file is the directory, never a child beside it.
		expect(mount.entries.map((entry) => entry.path)).toStrictEqual(["nested", "nested/leaf"]);
	});

	it("should carry a json module as a decode of its own text", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/preset.json`]: '{"a":1}' });

		const mount = onlyMount(split(fileSystem, stagingProject({ Out: { $path: OUT } })).bundle);

		expect(entryAt(mount, "preset").className).toBe("ModuleScript");
		expect(entryAt(mount, "preset").source).toBe(
			'return game:GetService("HttpService"):JSONDecode([==[{"a":1}]==])',
		);
	});

	it("should carry a mount past the files rojo builds nothing from", () => {
		expect.assertions(4);

		const { fileSystem } = seed({
			[`${OUT}/foo.d.ts`]: "export {};",
			[`${OUT}/foo.luau.map`]: "{}",
			[`${OUT}/foo.luau`]: "return {}",
		});

		// A stock roblox-ts `out/` holds both beside every script. Rojo knows
		// neither extension, so it builds no instance from either: nothing for
		// a task to rebuild, and nothing the place has to keep serving.
		const { bundle, fileCount, harness, stayed } = split(
			fileSystem,
			stagingProject({ Out: { $path: OUT } }),
		);

		expect(stayed).toStrictEqual([]);
		expect(onlyMount(bundle).entries.map((entry) => entry.path)).toStrictEqual(["foo"]);
		expect(fileCount).toBe(1);
		expect(staged(harness, "pkg", "Out")).toBeUndefined();
	});

	it("should promote a directory holding a file rojo builds nothing from", () => {
		expect.assertions(2);

		const { fileSystem } = seed({
			[`${OUT}/init.d.ts`]: "export {};",
			[`${OUT}/init.luau`]: "return 1",
		});

		// The declaration is not an `init` file of any kind, so it neither
		// promotes the directory nor stands beside the one that does.
		const mount = onlyMount(split(fileSystem, stagingProject({ Out: { $path: OUT } })).bundle);

		expect(mount.root).toStrictEqual({ className: "ModuleScript", source: "return 1" });
		expect(mount.entries).toStrictEqual([]);
	});

	it.for(["blocker.csv", "blocker.model.json", "blocker.rbxmx", "blocker.toml", "blocker.txt"])(
		"should keep a mount holding %s in the harness",
		(fileName) => {
			expect.assertions(2);

			// Rojo builds an instance from each of these and no task can
			// construct one, so the mount they sit in has to stay whole.
			const { fileSystem } = seed({
				[`${OUT}/${fileName}`]: "x",
				[`${OUT}/ok.luau`]: "return {}",
			});

			const { bundle, stayed } = split(fileSystem, stagingProject({ Out: { $path: OUT } }));

			expect(bundle.mounts).toStrictEqual([]);
			expect(stayed).toStrictEqual(["ServerStorage/__pkg_stage/pkg/Out"]);
		},
	);

	it("should keep a mount holding an asset in the harness and report it", () => {
		expect.assertions(4);

		const { fileSystem } = seed({
			[`${OUT}/model.rbxm`]: "binary",
			[`${OUT}/ok.luau`]: "return {}",
		});

		const { bundle, harness, stayed } = split(
			fileSystem,
			stagingProject({ Out: { $path: OUT } }),
		);

		expect(bundle.mounts).toStrictEqual([]);
		expect(stayed).toStrictEqual(["ServerStorage/__pkg_stage/pkg/Out"]);
		// Whole: the one script it also held stays with it, because a mount
		// split in halves would serve the asset from nowhere.
		expect(mountOf(harness, "pkg", "Out")).toBe(OUT);
		expect(harness).toStrictEqual(
			stagedProjectSchema.assert(JSON.parse(stagingProject({ Out: { $path: OUT } }))),
		);
	});

	it("should keep a mount holding a descriptor in the harness", () => {
		expect.assertions(2);

		const { fileSystem } = seed({
			[`${OUT}/thing.luau`]: "return {}",
			[`${OUT}/thing.meta.json`]: '{"properties":{}}',
		});

		const { bundle, stayed } = split(fileSystem, stagingProject({ Out: { $path: OUT } }));

		expect(bundle.mounts).toStrictEqual([]);
		expect(stayed).toStrictEqual(["ServerStorage/__pkg_stage/pkg/Out"]);
	});

	it("should keep a mount holding a nested project in the harness", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/inner.project.json`]: '{"name":"inner","tree":{}}',
			[`${OUT}/thing.luau`]: "return {}",
		});

		expect(split(fileSystem, stagingProject({ Out: { $path: OUT } })).stayed).toStrictEqual([
			"ServerStorage/__pkg_stage/pkg/Out",
		]);
	});

	it("should report a held-back mount once however deep the blocker sits", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/a/b/c/more.csv`]: "1,2",
			[`${OUT}/a/b/notes.txt`]: "hello",
		});

		expect(split(fileSystem, stagingProject({ Out: { $path: OUT } })).stayed).toStrictEqual([
			"ServerStorage/__pkg_stage/pkg/Out",
		]);
	});

	it("should carry a file mount as the one script it is", () => {
		expect.assertions(4);

		const { fileSystem } = seed({ [`${OUT}/stubs/jest.config.luau`]: "return {}" });

		const { bundle, harness } = split(
			fileSystem,
			stagingProject({ "jest.config": { $path: `${OUT}/stubs/jest.config.luau` } }),
		);
		const mount = onlyMount(bundle);

		// The tree key names the instance, so only the class and the source
		// travel — a file mount is the leaf rather than a tree under one.
		expect(mount.root).toStrictEqual({ className: "ModuleScript", source: "return {}" });
		expect(mount.entries).toStrictEqual([]);
		expect(staged(harness, "pkg", "jest.config")).toBeUndefined();
		// A node that names its own class describes an instance the place has
		// to hold, whether or not anything is left under it.
		expect(staged(harness, "pkg")).toStrictEqual({ $className: "Folder" });
	});

	it("should read a node's own metadata as metadata rather than as children", () => {
		expect.assertions(3);

		const { fileSystem } = seed({ [`${OUT}/code.luau`]: "return {}" });

		// `$attributes` and `$properties` hold objects, so a walk that told
		// them apart from a child by shape alone would call a childless mount
		// a merge and prune a node's own metadata out of the harness.
		const { bundle, harness } = split(
			fileSystem,
			stagedProject({
				pkg: {
					$className: "Folder",
					$properties: { Archivable: false },
					Out: { $attributes: { Tag: "x" }, $path: OUT },
				},
			}),
		);

		expect(onlyMount(bundle).merge).toBeFalse();
		expect(staged(harness, "pkg", "Out")).toBeUndefined();
		expect(staged(harness, "pkg")).toStrictEqual({
			$className: "Folder",
			$properties: { Archivable: false },
		});
	});

	it("should carry a mount inside any one of several code roots", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [`${INCLUDE}/runtime.luau`]: "return {}" });

		// A workspace run names one Code Root per package plus the cache
		// directory, so a mount reaches the bundle by matching any of them.
		const { bundle } = split(fileSystem, stagingProject({ Include: { $path: INCLUDE } }), [
			toPosixRoot(OUT),
			toPosixRoot(INCLUDE),
		]);

		expect(onlyMount(bundle).dataModelPath).toStrictEqual([
			"ServerStorage",
			"__pkg_stage",
			"pkg",
			"Include",
		]);
	});

	it("should carry a scoped package's stage name as one segment", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/index.luau`]: "return {}" });

		// A workspace run names each stage node after the package, slash and
		// all. Joined into one string the mount travels as
		// `.../@scope/pkg/Out` and the rebuild made two Folders out of it,
		// leaving the stage the materializer clones from empty.
		const { bundle } = split(
			fileSystem,
			stagedProject({ "@scope/pkg": { $className: "Folder", Out: { $path: OUT } } }),
		);

		expect(onlyMount(bundle).dataModelPath).toStrictEqual([
			"ServerStorage",
			"__pkg_stage",
			"@scope/pkg",
			"Out",
		]);
		// One segment per tree node, which is what says the slash was never
		// read as a separator.
		expect(onlyMount(bundle).dataModelPath).toHaveLength(4);
	});

	it("should sort a directory's entries however the host lists them", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		// Written back to front, which is what a host listing by creation
		// order hands back. The bundle is an artifact, so the same tree has to
		// come out as the same bytes wherever it is read.
		fileSystem.mkdirSync(OUT, { recursive: true });
		for (const name of ["c", "b", "a"]) {
			fileSystem.writeFileSync(`${OUT}/${name}.luau`, `return "${name}"`);
		}

		const mount = onlyMount(split(fileSystem, stagingProject({ Out: { $path: OUT } })).bundle);

		expect(mount.entries.map((entry) => entry.path)).toStrictEqual(["a", "b", "c"]);
	});

	it("should honour an ignore pattern that reaches a dotfile", () => {
		expect.assertions(2);

		const { fileSystem } = seed({
			[`${OUT}/.notes.txt`]: "hello",
			[`${OUT}/keep.luau`]: "return {}",
		});

		// A leading dot hides a file from an ordinary glob, and a blocker rojo
		// never reads is not what holds a mount back.
		const { bundle, stayed } = split(
			fileSystem,
			stagingProject({ Out: { $path: OUT } }, ["**/*.txt"]),
		);

		expect(stayed).toStrictEqual([]);
		expect(onlyMount(bundle).entries.map((entry) => entry.path)).toStrictEqual(["keep"]);
	});

	it("should keep a file mount no task can construct", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/assets/gui.rbxmx`]: "<roblox/>" });

		const { bundle, stayed } = split(
			fileSystem,
			stagingProject({ Gui: { $path: `${OUT}/assets/gui.rbxmx` } }),
		);

		expect(bundle.mounts).toStrictEqual([]);
		expect(stayed).toStrictEqual(["ServerStorage/__pkg_stage/pkg/Gui"]);
	});

	it("should leave a file mount rojo builds nothing from alone", () => {
		expect.assertions(3);

		const declaration = `${OUT}/types/globals.d.ts`;
		const { fileSystem } = seed({ [declaration]: "export {};" });

		const { bundle, harness, stayed } = split(
			fileSystem,
			stagingProject({ Types: { $path: declaration } }),
		);

		expect(bundle.mounts).toStrictEqual([]);
		// Rojo built no instance there, so no speedup was left on the table
		// and the node can stay exactly as the project wrote it.
		expect(stayed).toStrictEqual([]);
		expect(mountOf(harness, "pkg", "Types")).toBe(declaration);
	});

	it("should leave a mount outside every code root alone", () => {
		expect.assertions(3);

		const { fileSystem } = seed({ [`${INCLUDE}/runtime.luau`]: "return {}" });

		const { bundle, harness, stayed } = split(
			fileSystem,
			stagingProject({ Include: { $path: INCLUDE } }),
		);

		expect(bundle.mounts).toStrictEqual([]);
		// Not a finding either: nothing about it was ever going to travel.
		expect(stayed).toStrictEqual([]);
		expect(mountOf(harness, "pkg", "Include")).toBe(INCLUDE);
	});

	it("should leave a mount that is not on disk alone", () => {
		expect.assertions(2);

		const { fileSystem } = seed();

		const { harness, stayed } = split(fileSystem, stagingProject({ Out: { $path: OUT } }));

		expect(stayed).toStrictEqual([]);
		expect(mountOf(harness, "pkg", "Out")).toBe(OUT);
	});

	it("should leave a file the project ignores out of the bundle", () => {
		expect.assertions(2);

		const { fileSystem } = seed({
			[`${OUT}/keep.luau`]: "return {}",
			[`${OUT}/skip.rbxm`]: "binary",
		});

		// Ignored, so rojo builds nothing from it — and a blocker rojo never
		// reads cannot be what holds the mount back.
		const { bundle, stayed } = split(
			fileSystem,
			stagingProject({ Out: { $path: OUT } }, ["**/skip.rbxm"]),
		);

		expect(stayed).toStrictEqual([]);
		expect(onlyMount(bundle).entries.map((entry) => entry.path)).toStrictEqual(["keep"]);
	});

	it("should mark a mount the project declares children beside as a merge", () => {
		expect.assertions(3);

		const { fileSystem } = seed({ [`${OUT}/code.luau`]: "return {}" });

		const { bundle, harness } = split(
			fileSystem,
			stagingProject({
				Out: { $path: OUT, Extra: { $className: "Folder", $path: INCLUDE } },
			}),
		);

		expect(onlyMount(bundle).merge).toBeTrue();
		// The node stays as a Folder so the children it declared keep being
		// served by the place; only the mount itself goes.
		expect(staged(harness, "pkg", "Out")).toStrictEqual({
			$className: "Folder",
			Extra: { $className: "Folder", $path: INCLUDE },
		});
		expect(mountOf(harness, "pkg", "Out")).toBeUndefined();
	});

	it("should take an ancestor left with nothing out with the mount", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/code.luau`]: "return {}" });

		const { bundle, harness } = split(
			fileSystem,
			stagedProject({ pkg: { Deep: { Out: { $path: OUT } } } }),
		);

		expect(onlyMount(bundle).merge).toBeFalse();
		expect(staged(harness, "pkg")).toBeUndefined();
	});

	it("should never prune a service the stage hangs off", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/code.luau`]: "return {}" });

		// A service is named for rojo rather than for what sits under it, so
		// an emptied one still has to be there for the next mount to land in.
		const { harness } = split(
			fileSystem,
			JSON.stringify({
				name: "synth",
				tree: { $className: "DataModel", ReplicatedStorage: { Code: { $path: OUT } } },
			}),
		);
		const { tree } = harness;

		expect(tree).toStrictEqual({ $className: "DataModel", ReplicatedStorage: {} });
		expect(JSON.stringify(tree)).not.toContain("Code");
	});

	it("should order mounts and entries shallowest first", () => {
		expect.assertions(2);

		const { fileSystem } = seed({
			[`${OUT}/deep/a/b/leaf.luau`]: "return {}",
			[`${OUT}/nested/inner.luau`]: "return {}",
			[`${OUT}/top.luau`]: "return {}",
		});

		// An outer mount replaces what it holds, so it has to land before the
		// mount nested inside it; the same rule inside one mount is what makes
		// an `init`-promoted directory exist before its descendants.
		const { bundle } = split(
			fileSystem,
			stagedProject({
				pkg: {
					$className: "Folder",
					Deep: { Inner: { $path: `${OUT}/nested` } },
					Out: { $path: OUT },
				},
			}),
		);

		expect(bundle.mounts.map((mount) => mount.dataModelPath)).toStrictEqual([
			["ServerStorage", "__pkg_stage", "pkg", "Out"],
			["ServerStorage", "__pkg_stage", "pkg", "Deep", "Inner"],
		]);
		expect(bundle.mounts[0]!.entries.map((entry) => entry.path)).toStrictEqual([
			"deep",
			"nested",
			"top",
			"deep/a",
			"nested/inner",
			"deep/a/b",
			"deep/a/b/leaf",
		]);
	});

	it("should stamp the format version the rebuild checks", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		expect(split(fileSystem, stagingProject({})).bundle.version).toBe(1);
	});

	it("should count every file the bundle carries", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/init.luau`]: "return 1",
			[`${OUT}/nested/leaf.luau`]: "return 2",
			[`${OUT}/preset.json`]: "{}",
		});

		// The promoted root and the two entries that carry source; the Folder
		// standing for `nested` is not a file anyone compiled.
		expect(split(fileSystem, stagingProject({ Out: { $path: OUT } })).fileCount).toBe(3);
	});

	it("should hand back the project unchanged when nothing travels", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [`${INCLUDE}/runtime.luau`]: "return {}" });
		const projectJson = stagingProject({ Include: { $path: INCLUDE } });

		expect(
			splitCodeMounts({
				codeRoots: [toPosixRoot(OUT)],
				fileSystem,
				projectDirectory: PROJECT_DIR,
				projectJson,
			}).harnessProjectJson,
		).toBe(projectJson);
	});

	it.for([String.raw`{"name":"synth"}`, "[]"])(
		"should hand back a project it cannot read unchanged: %s",
		(projectJson) => {
			expect.assertions(3);

			const { fileSystem } = seed();
			const result = splitCodeMounts({
				codeRoots: [toPosixRoot(OUT)],
				fileSystem,
				projectDirectory: PROJECT_DIR,
				projectJson,
			});

			expect(result.harnessProjectJson).toBe(projectJson);
			expect(bundleSchema.assert(JSON.parse(result.bundleJson)).mounts).toStrictEqual([]);
			// Nothing was read, so nothing stayed behind either — a finding
			// here would name a mount no walk ever reached.
			expect(result.stayedMounts).toStrictEqual([]);
		},
	);

	it("should leave a mount the project ignores whole alone", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/code.luau`]: "return {}" });

		// Rojo builds nothing from it, so there is nothing to carry and the
		// node can stay exactly as the project wrote it.
		const { bundle, harness } = split(
			fileSystem,
			stagingProject({ Out: { $path: OUT } }, [`**${normalizeWindowsPath(OUT)}`]),
		);

		expect(bundle.mounts).toStrictEqual([]);
		expect(mountOf(harness, "pkg", "Out")).toBe(OUT);
	});

	it("should resolve a relative mount against the project directory", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [`${PROJECT_DIR}/staged/code.luau`]: "return {}" });

		const { bundle } = split(fileSystem, stagingProject({ Out: { $path: "staged" } }), [
			toPosixRoot(path.join(PROJECT_DIR, "staged")),
		]);

		expect(onlyMount(bundle).entries.map((entry) => entry.path)).toStrictEqual(["code"]);
	});
});
