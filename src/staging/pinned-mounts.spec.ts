import { fromAny } from "@total-typescript/shoehorn";

import { type, type Type } from "arktype";
import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/errors.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { demotePinnedMounts } from "./pinned-mounts.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("../utils/rojo-builder"));

const PROJECT_DIR = path.resolve("/cache");
const SHADOW_DIR = path.join(PROJECT_DIR, "pinned-shadow");
const ASSETS = path.resolve("/repo/game-assets");
const META_JSON = "init.meta.json";

// Rojo tree nodes are keyed by arbitrary instance names dictated by the
// fixture's project.json, so they are read through one owned schema rather
// than an ad-hoc cast per test.
const rojoTreeNodeSchema: Type<RojoTreeNode> = type({
	"[string]": "unknown",
}).as<RojoTreeNode>();

const demotedProjectSchema = type({
	"[string]": "unknown",
	"globIgnorePaths?": "string[]",
	"tree": "object",
});

/**
 * A model whose root is a service, as `rojo build` would emit it. The nested
 * Folder is a consumer-authored one carrying a property of its own, so a
 * stripping pass that cannot tell it from a rewritten root shows up here.
 */
function serviceModelXml(rootClass: string): string {
	return [
		'<roblox version="4">',
		`  <Item class="${rootClass}" referent="0">`,
		"    <Properties>",
		`      <string name="Name">${rootClass}</string>`,
		'      <bool name="Anchored">true</bool>',
		'      <BinaryString name="Tags"></BinaryString>',
		"    </Properties>",
		'    <Item class="Folder" referent="1">',
		"      <Properties>",
		'        <string name="Name">Nested</string>',
		'        <int64 name="SourceAssetId">99</int64>',
		"      </Properties>",
		"    </Item>",
		'    <Item class="ModuleScript" referent="2">',
		"      <Properties>",
		'        <string name="Name">Child</string>',
		"      </Properties>",
		"    </Item>",
		"  </Item>",
		"</roblox>",
	].join("\n");
}

/**
 * Resets the volume and stands rojo up as a stub that writes the model a real
 * build would have produced, so the class-folding pass has something to read.
 */
function seed(files: Record<string, string> = {}): void {
	vol.reset();
	vol.fromJSON(files);
	vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
		vol.writeFileSync(outputPath, serviceModelXml("StarterPlayerScripts"));
	});
}

function stagedProject(stage: RojoTreeNode, globIgnorePaths?: Array<string>): string {
	return JSON.stringify({
		...(globIgnorePaths === undefined ? {} : { globIgnorePaths }),
		name: "jest-roblox-workspace",
		tree: {
			$className: "DataModel",
			ServerStorage: { $className: "ServerStorage", __pkg_stage: stage },
		},
	});
}

/**
 * The shape every walk test shares: one package staging a single service that
 * auto-mounts a directory of assets.
 */
function directoryMount(
	service: string,
	directory: string,
	globIgnorePaths?: Array<string>,
): string {
	return stagedProject(
		{ pkg: { $className: "Folder", [service]: { $className: "Folder", $path: directory } } },
		globIgnorePaths,
	);
}

function run(projectJson: string): string {
	return demotePinnedMounts({
		projectDirectory: PROJECT_DIR,
		projectJson,
		shadowDirectory: SHADOW_DIR,
	});
}

function demote(projectJson: string): typeof demotedProjectSchema.infer {
	return demotedProjectSchema.assert(JSON.parse(run(projectJson)));
}

/** Reads a foreign tree-node key, validating the child is itself a node. */
function child(node: RojoTreeNode, key: string): RojoTreeNode | undefined {
	const value = node[key];
	return value === undefined ? undefined : rojoTreeNodeSchema.assert(value);
}

/**
 * Walks from the stage down a chain of node keys, short-circuiting on a miss.
 */
function staged(
	project: typeof demotedProjectSchema.infer,
	...keys: Array<string>
): RojoTreeNode | undefined {
	return ["ServerStorage", "__pkg_stage", ...keys].reduce<RojoTreeNode | undefined>(
		(current, key) => (current === undefined ? undefined : child(current, key)),
		rojoTreeNodeSchema.assert(project.tree),
	);
}

/** The `$path` a staged node mounts, or `undefined` when it mounts nothing. */
function mountOf(
	project: typeof demotedProjectSchema.infer,
	...keys: Array<string>
): string | undefined {
	const value = staged(project, ...keys)?.$path;
	return typeof value === "string" ? value : undefined;
}

describe(demotePinnedMounts, () => {
	it("should leave a project with no stage untouched", () => {
		expect.assertions(1);

		seed();
		// A no-wrap project keeps every service where the engine wants it.
		const projectJson = JSON.stringify({ name: "p", tree: { $className: "DataModel" } });

		expect(run(projectJson)).toBe(projectJson);
	});

	it.for([
		["a non-object project", "null"],
		["a project with no tree", '{"name":"p"}'],
		["a project whose ServerStorage is not a node", '{"tree":{"ServerStorage":7}}'],
		["a project with no stage", '{"tree":{"ServerStorage":{}}}'],
	] as const)("should leave %s untouched", ([, projectJson]) => {
		expect.assertions(1);

		seed();

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should leave a stage whose mounts declare no pinned class untouched", () => {
		expect.assertions(1);

		seed({ [path.join(ASSETS, "src/init.luau")]: "" });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: path.join(ASSETS, "src") } },
		});

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should point a mount that is itself a pinned model at the stand-in", () => {
		expect.assertions(2);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = demote(
			stagedProject({
				pkg: {
					$className: "Folder",
					StarterPlayer: {
						$className: "Folder",
						StarterPlayerScripts: { $path: model },
					},
				},
			}),
		);

		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
		// The node already names the instance, so nothing has to be ignored.
		expect(project.globIgnorePaths).toStrictEqual([]);
	});

	it("should declare a stand-in child and ignore the original it replaces", () => {
		expect.assertions(3);

		seed({
			[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts.rbxmx")]:
				serviceModelXml("StarterPlayerScripts"),
		});

		const project = demote(directoryMount("StarterPlayer", path.join(ASSETS, "StarterPlayer")));

		// The auto-mount stays, less the one entry the stand-in replaces.
		expect(mountOf(project, "pkg", "StarterPlayer")).toBe(path.join(ASSETS, "StarterPlayer"));
		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
		expect(project.globIgnorePaths![0]).toContain("StarterPlayerScripts.rbxmx");
	});

	it("should replace a directory entry whose init.meta.json declares a pinned class", () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts/init.meta.json")]:
				'{"className":"StarterPlayerScripts"}',
		});

		const project = demote(directoryMount("StarterPlayer", path.join(ASSETS, "StarterPlayer")));

		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
	});

	it("should point a mount whose own init.meta.json declares the class at the stand-in", () => {
		expect.assertions(2);

		seed({
			[path.join(ASSETS, "SPS/init.meta.json")]: '{"className":"StarterPlayerScripts"}',
			[path.join(ASSETS, "SPS/mod.luau")]: "return 1",
		});

		const project = demote(
			stagedProject({
				pkg: {
					$className: "Folder",
					StarterPlayer: {
						$className: "Folder",
						StarterPlayerScripts: { $path: path.join(ASSETS, "SPS") },
					},
				},
			}),
		);

		// The meta file classes the instance rojo builds for the whole mount, so
		// the mount is the offender. Treating it as a child entry instead would
		// mount a lone descriptor, which rojo cannot turn into an Instance.
		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
		expect(
			staged(project, "pkg", "StarterPlayer", "StarterPlayerScripts", META_JSON),
		).toBeUndefined();
	});

	it("should fold the pinned class to Folder and drop the properties it carried", () => {
		expect.assertions(4);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = demote(
			stagedProject({ pkg: { $className: "Folder", Scripts: { $path: model } } }),
		);
		const shadow = String(
			vol.readFileSync(String(mountOf(project, "pkg", "Scripts")), "utf-8"),
		);

		expect(shadow).toContain('<Item class="Folder" referent="0">');
		expect(shadow).toContain('<string name="Name">StarterPlayerScripts</string>');
		// `Anchored` belonged to the class that was rewritten away.
		expect(shadow).not.toContain("Anchored");
		// A child that is not pinned keeps its class and its properties.
		expect(shadow).toContain('<Item class="ModuleScript" referent="2">');
	});

	it("should leave a Folder the consumer authored holding its own properties", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = demote(
			stagedProject({ pkg: { $className: "Folder", Scripts: { $path: model } } }),
		);
		const shadow = String(
			vol.readFileSync(String(mountOf(project, "pkg", "Scripts")), "utf-8"),
		);

		// Stripping after the class fold would reach this one too: by then the
		// rewritten root also reads `Folder`, and nothing tells them apart.
		expect(shadow).toContain('<int64 name="SourceAssetId">99</int64>');
	});

	it("should skip a mount the project already ignores", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		seed({ [model]: serviceModelXml("Terrain") });
		const projectJson = stagedProject(
			{ pkg: { $className: "Folder", Terrain: { $path: model } } },
			["**/Workspace/Terrain.rbxmx"],
		);

		// A consumer who worked around this bug by ignoring the file must not
		// have an empty stand-in put back in its place.
		expect(run(projectJson)).toBe(projectJson);
	});

	it("should skip a mounted entry the project already ignores", () => {
		expect.assertions(1);

		seed({ [path.join(ASSETS, "Workspace/Terrain.rbxmx")]: serviceModelXml("Terrain") });
		const projectJson = directoryMount("Workspace", path.join(ASSETS, "Workspace"), [
			"**/Terrain.rbxmx",
		]);

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should ignore a mount that is not on disk", () => {
		expect.assertions(1);

		seed();
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: path.join(ASSETS, "missing") } },
		});

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should ignore a mount that is a file rojo reads without a class", () => {
		expect.assertions(1);

		const source = path.join(ASSETS, "init.luau");
		seed({ [source]: "return {}" });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: source } },
		});

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should ignore a mounted model whose own root is not pinned", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "pod.rbxmx");
		seed({ [model]: serviceModelXml("Model") });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", Pod: { $path: model } },
		});

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should not report a buried pinned class the project already ignores", () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")]: serviceModelXml("Terrain"),
			[path.join(ASSETS, "Workspace/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});

		const project = demote(
			directoryMount("Workspace", path.join(ASSETS, "Workspace"), ["**/lobby/Terrain.rbxmx"]),
		);

		expect(mountOf(project, "pkg", "Workspace", "Terrain")).toContain("pinned-shadow");
	});

	it("should report a pinned class buried below the mount rather than rebuilding it", () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});

		// Such a file is in the wrong parent in the consumer's own place too, so
		// no stand-in this module writes would make it load.
		expect(() => {
			return run(directoryMount("Workspace", path.join(ASSETS, "Workspace")));
		}).toThrow(ConfigError);
	});

	it("should walk past a nested directory that holds no pinned class", () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/lobby/pod.rbxmx")]: serviceModelXml("Model"),
			[path.join(ASSETS, "Workspace/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});

		const project = demote(directoryMount("Workspace", path.join(ASSETS, "Workspace")));

		expect(mountOf(project, "pkg", "Workspace", "Terrain")).toContain("pinned-shadow");
	});

	it.for([
		[
			"StarterPlayerScripts.rbxmx",
			serviceModelXml("StarterPlayerScripts"),
			"StarterPlayerScripts",
		],
		["Terrain.model.json", '{"ClassName":"Terrain"}', "Terrain"],
		["Scripts/init.meta.json", '{"className":"StarterPlayerScripts"}', "Scripts"],
	] as const)(
		"should name the stand-in for %s after the instance rojo would build",
		([fileName, contents, instanceName]) => {
			expect.assertions(1);

			seed({ [path.join(ASSETS, "StarterPlayer", fileName)]: contents });

			const project = demote(
				directoryMount("StarterPlayer", path.join(ASSETS, "StarterPlayer")),
			);

			expect(staged(project, "pkg", "StarterPlayer", instanceName)).toBeDefined();
		},
	);
});
