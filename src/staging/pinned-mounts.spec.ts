import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { vol } from "memfs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	mountOf,
	seed as seedVolume,
	staged,
	stagedProject,
	stagedProjectSchema,
} from "../../test/mocks/staged-project.ts";
import { ConfigError } from "../config/errors.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import { demotePinnedMountsAsync } from "./pinned-mounts.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("../utils/rojo-builder"));

const PROJECT_DIR = path.resolve("/cache");
const SHADOW_DIR = path.join(PROJECT_DIR, "pinned-shadow");
const ASSETS = path.resolve("/repo/game-assets");
const META_JSON = "init.meta.json";

const demotedProjectSchema = stagedProjectSchema.and(type({ "globIgnorePaths?": "string[]" }));

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
 * Seeds the volume and stands rojo up as a stub that writes the model a real
 * build would have produced, so the class-folding pass has something to read.
 */
function seed(files: Record<string, string> = {}): void {
	seedVolume(files);
	vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
		vol.writeFileSync(outputPath, serviceModelXml("StarterPlayerScripts"));
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

async function runAsync(projectJson: string): Promise<string> {
	return demotePinnedMountsAsync({
		projectDirectory: PROJECT_DIR,
		projectJson,
		shadowDirectory: SHADOW_DIR,
	});
}

async function demoteAsync(projectJson: string): Promise<typeof demotedProjectSchema.infer> {
	return demotedProjectSchema.assert(JSON.parse(await runAsync(projectJson)));
}

describe(demotePinnedMountsAsync, () => {
	it("should leave a project with no stage untouched", async () => {
		expect.assertions(1);

		seed();
		// A no-wrap project keeps every service where the engine wants it.
		const projectJson = JSON.stringify({ name: "p", tree: { $className: "DataModel" } });

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it.for([
		["a non-object project", "null"],
		["a project with no tree", '{"name":"p"}'],
		["a project whose ServerStorage is not a node", '{"tree":{"ServerStorage":7}}'],
		["a project with no stage", '{"tree":{"ServerStorage":{}}}'],
	] as const)("should leave %s untouched", async ([, projectJson]) => {
		expect.assertions(1);

		seed();

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should leave a stage whose mounts declare no pinned class untouched", async () => {
		expect.assertions(1);

		seed({ [path.join(ASSETS, "src/init.luau")]: "" });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: path.join(ASSETS, "src") } },
		});

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should point a mount that is itself a pinned model at the stand-in", async () => {
		expect.assertions(2);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = await demoteAsync(
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

	it("should build an own-mount stand-in from the exact stable shadow contract", async () => {
		expect.assertions(2);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });
		const project = await demoteAsync(
			stagedProject({ pkg: { $className: "Folder", Scripts: { $path: model } } }),
		);
		const normalizedSource = model.replaceAll("\\", "/");
		const digest = crypto
			.createHash("sha256")
			.update(normalizedSource)
			.digest("hex")
			.slice(0, 8);
		const expectedShadow = path.posix.join(
			SHADOW_DIR.replaceAll("\\", "/"),
			`StarterPlayerScripts-${digest}.rbxmx`,
		);

		expect(mountOf(project, "pkg", "Scripts")).toBe(expectedShadow);

		const [projectFile, shadowFile] = vi.mocked(buildWithRojoAsync).mock.calls[0]!;

		expect({
			project: JSON.parse(String(vol.readFileSync(projectFile, "utf-8"))),
			shadowFile,
		}).toStrictEqual({
			project: {
				name: "StarterPlayerScripts",
				globIgnorePaths: [],
				tree: { $path: normalizedSource },
			},
			shadowFile: expectedShadow,
		});
	});

	it("should declare a stand-in child and ignore the original it replaces", async () => {
		expect.assertions(3);

		seed({
			[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts.rbxmx")]:
				serviceModelXml("StarterPlayerScripts"),
		});

		const project = await demoteAsync(
			directoryMount("StarterPlayer", path.join(ASSETS, "StarterPlayer")),
		);

		// The auto-mount stays, less the one entry the stand-in replaces.
		expect(mountOf(project, "pkg", "StarterPlayer")).toBe(path.join(ASSETS, "StarterPlayer"));
		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
		expect(project.globIgnorePaths![0]).toContain("StarterPlayerScripts.rbxmx");
	});

	it("should replace a directory entry whose init.meta.json declares a pinned class", async () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts/init.meta.json")]:
				'{"className":"StarterPlayerScripts"}',
		});

		const project = await demoteAsync(
			directoryMount("StarterPlayer", path.join(ASSETS, "StarterPlayer")),
		);

		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
	});

	it("should point a mount whose own init.meta.json declares the class at the stand-in", async () => {
		expect.assertions(2);

		seed({
			[path.join(ASSETS, "SPS/init.meta.json")]: '{"className":"StarterPlayerScripts"}',
			[path.join(ASSETS, "SPS/mod.luau")]: "return 1",
		});

		const project = await demoteAsync(
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

	it("should fold the pinned class to Folder and drop the properties it carried", async () => {
		expect.assertions(5);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = await demoteAsync(
			stagedProject({ pkg: { $className: "Folder", Scripts: { $path: model } } }),
		);
		const shadow = String(
			vol.readFileSync(String(mountOf(project, "pkg", "Scripts")), "utf-8"),
		);

		// This XML is the stand-in Rojo consumes. The digest guards its complete
		// rewrite while the assertions below explain the semantics.
		expect(shadow).toMatchSnapshot();

		expect(shadow).toContain('<Item class="Folder" referent="0">');
		expect(shadow).toContain('<string name="Name">StarterPlayerScripts</string>');
		// `Anchored` belonged to the class that was rewritten away.
		expect(shadow).not.toContain("Anchored");
		// A child that is not pinned keeps its class and its properties.
		expect(shadow).toContain('<Item class="ModuleScript" referent="2">');
	});

	it("should leave a Folder the consumer authored holding its own properties", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = await demoteAsync(
			stagedProject({ pkg: { $className: "Folder", Scripts: { $path: model } } }),
		);
		const shadow = String(
			vol.readFileSync(String(mountOf(project, "pkg", "Scripts")), "utf-8"),
		);

		// Stripping after the class fold would reach this one too: by then the
		// rewritten root also reads `Folder`, and nothing tells them apart.
		expect(shadow).toContain('<int64 name="SourceAssetId">99</int64>');
	});

	it("should skip a mount the project already ignores", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		seed({ [model]: serviceModelXml("Terrain") });
		const projectJson = stagedProject(
			{ pkg: { $className: "Folder", Terrain: { $path: model } } },
			["**/Workspace/Terrain.rbxmx"],
		);

		// A consumer who worked around this bug by ignoring the file must not
		// have an empty stand-in put back in its place.
		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should match an absolute ignore path after removing the Windows drive letter", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		seed({ [model]: serviceModelXml("Terrain") });
		const normalizedWithoutDrive = model.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
		const projectJson = stagedProject(
			{ pkg: { $className: "Folder", Terrain: { $path: model } } },
			[normalizedWithoutDrive],
		);

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should discard non-string globIgnorePaths entries", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		seed({ [model]: serviceModelXml("Terrain") });
		const projectJson = stagedProject(
			{ pkg: { $className: "Folder", Terrain: { $path: model } } },
			fromAny([false, 42, "**/Workspace/Terrain.rbxmx"]),
		);

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should skip a mounted entry the project already ignores", async () => {
		expect.assertions(1);

		seed({ [path.join(ASSETS, "Workspace/Terrain.rbxmx")]: serviceModelXml("Terrain") });
		const projectJson = directoryMount("Workspace", path.join(ASSETS, "Workspace"), [
			"**/Terrain.rbxmx",
		]);

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should ignore a mount that is not on disk", async () => {
		expect.assertions(1);

		seed();
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: path.join(ASSETS, "missing") } },
		});

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should ignore a mount that is a file rojo reads without a class", async () => {
		expect.assertions(1);

		const source = path.join(ASSETS, "init.luau");
		seed({ [source]: "return {}" });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: source } },
		});

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should ignore a mounted model whose own root is not pinned", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "pod.rbxmx");
		seed({ [model]: serviceModelXml("Model") });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", Pod: { $path: model } },
		});

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should not report a buried pinned class the project already ignores", async () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")]: serviceModelXml("Terrain"),
			[path.join(ASSETS, "Workspace/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});

		const project = await demoteAsync(
			directoryMount("Workspace", path.join(ASSETS, "Workspace"), ["**/lobby/Terrain.rbxmx"]),
		);

		expect(mountOf(project, "pkg", "Workspace", "Terrain")).toContain("pinned-shadow");
	});

	it("should apply ignore globs to dot-directories", async () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/.generated/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});
		const projectJson = directoryMount("Workspace", path.join(ASSETS, "Workspace"), ["**/*"]);

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should report a pinned class buried below the mount rather than rebuilding it", async () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});

		// Such a file is in the wrong parent in the consumer's own place too, so
		// no stand-in this module writes would make it load.
		const mountRoot = path.join(ASSETS, "Workspace");
		const buried = path
			.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")
			.replaceAll("\\", "/");

		await expect(
			runAsync(directoryMount("Workspace", path.join(ASSETS, "Workspace"))),
		).rejects.toThrow(
			new ConfigError(
				`"${buried}" declares Terrain, which the engine parents only under one service, but it is nested inside the mount at "${mountRoot}" rather than sitting directly in it. ` +
					"Roblox rejects it wherever that mount lands, so move the file up to the directory mounted at its own service, or drop it from the project with `globIgnorePaths`.",
			),
		);
	});

	it("should walk past a nested directory that holds no pinned class", async () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/lobby/pod.rbxmx")]: serviceModelXml("Model"),
			[path.join(ASSETS, "Workspace/Terrain.rbxmx")]: serviceModelXml("Terrain"),
		});

		const project = await demoteAsync(
			directoryMount("Workspace", path.join(ASSETS, "Workspace")),
		);

		expect(mountOf(project, "pkg", "Workspace", "Terrain")).toContain("pinned-shadow");
	});

	it("should leave an auto-mounted directory of ordinary files unchanged", async () => {
		expect.assertions(1);

		seed({
			[path.join(ASSETS, "Workspace/maps/config.model.json")]: '{"ClassName":"Model"}',
			[path.join(ASSETS, "Workspace/maps/init.luau")]: "return {}",
		});
		const projectJson = directoryMount("Workspace", path.join(ASSETS, "Workspace"));

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should not treat an init.meta.json directory as a class descriptor", async () => {
		expect.assertions(1);

		seed({ [path.join(ASSETS, "src/Child/init.meta.json/value.luau")]: "return 1" });
		const projectJson = directoryMount("Workspace", path.join(ASSETS, "src"));

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
	});

	it("should scan a shared mount path once", async () => {
		expect.assertions(1);

		const shared = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		seed({ [shared]: serviceModelXml("StarterPlayerScripts") });
		await demoteAsync(
			stagedProject({
				pkg: {
					$className: "Folder",
					First: { $path: shared },
					Second: { $path: shared },
				},
			}),
		);

		expect(buildWithRojoAsync).toHaveBeenCalledOnce();
	});

	it("should not recurse into reserved dollar-prefixed metadata nodes", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Terrain.rbxmx");
		seed({ [model]: serviceModelXml("Terrain") });
		const projectJson = stagedProject({
			pkg: {
				$className: "Folder",
				$metadata: { $path: model },
			},
		});

		await expect(runAsync(projectJson)).resolves.toBe(projectJson);
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
		async ([fileName, contents, instanceName]) => {
			expect.assertions(1);

			seed({ [path.join(ASSETS, "StarterPlayer", fileName)]: contents });

			const project = await demoteAsync(
				directoryMount("StarterPlayer", path.join(ASSETS, "StarterPlayer")),
			);

			expect(staged(project, "pkg", "StarterPlayer", instanceName)).toBeDefined();
		},
	);
});
