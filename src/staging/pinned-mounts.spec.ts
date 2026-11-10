import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import {
	mountOf,
	seed as seedVolume,
	staged,
	stagedProject,
	stagedProjectSchema,
} from "#test/mocks/staged-project.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { demotePinnedMountsAsync } from "./pinned-mounts.ts";

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

const PROJECT_DIR = path.resolve("/cache");
const SHADOW_DIR = path.join(PROJECT_DIR, "pinned-shadow");
const ASSETS = path.resolve("/repo/game-assets");
const META_JSON = "init.meta.json";

const demotedProjectSchema = stagedProjectSchema.and(type({ "globIgnorePaths?": "string[]" }));

/**
 * A model whose root is a service, as `rojo build` would emit it. The nested
 * Folder is a consumer-authored one carrying a property of its own, so a
 * stripping pass that cannot tell it from a rewritten root shows up here.
 * @param rootClass - Class of the model's root item.
 * @returns The `.rbxmx` text.
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

function seed(files: Record<string, string> = {}): Harness {
	const memory = seedVolume(files);
	const execFile = vi.fn<RojoExec>(
		writingRojoExec({
			bytes: serviceModelXml("StarterPlayerScripts"),
			fileSystem: memory.volume,
		}),
	);
	return { ...memory, childProcess: fromAny({ execFile }), execFile };
}

/**
 * The shape every walk test shares: one package staging a single service that
 * auto-mounts a directory of assets.
 * @param service - Service key the directory mounts under.
 * @param options - The directory and the project's ignore list.
 * @param options.directory - Directory the service mounts.
 * @param options.globIgnorePaths - Patterns the project ignores.
 * @returns The project text.
 */
function directoryMount(
	service: string,
	{
		directory,
		globIgnorePaths,
	}: { directory: string; globIgnorePaths?: Array<string> | undefined },
): string {
	return stagedProject(
		{ pkg: { $className: "Folder", [service]: { $className: "Folder", $path: directory } } },
		globIgnorePaths,
	);
}

async function runAsync(
	{ childProcess, fileSystem }: Harness,
	projectJson: string,
): Promise<string> {
	return demotePinnedMountsAsync({
		childProcess,
		fileSystem,
		projectDirectory: PROJECT_DIR,
		projectJson,
		shadowDirectory: SHADOW_DIR,
	});
}

async function demoteAsync(
	harness: Harness,
	projectJson: string,
): Promise<typeof demotedProjectSchema.infer> {
	return demotedProjectSchema.assert(JSON.parse(await runAsync(harness, projectJson)));
}

async function demotedScriptsShadowAsync(): Promise<string> {
	const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
	const rojo = seed({ [model]: serviceModelXml("StarterPlayerScripts") });

	const project = await demoteAsync(
		rojo,
		stagedProject({ pkg: { $className: "Folder", Scripts: { $path: model } } }),
	);
	return String(rojo.volume.readFileSync(String(mountOf(project, "pkg", "Scripts")), "utf-8"));
}

describe(demotePinnedMountsAsync, () => {
	it("should leave a project with no stage untouched", async () => {
		expect.assertions(1);

		const rojo = seed();
		// A no-wrap project keeps every service where the engine wants it.
		const projectJson = JSON.stringify({ name: "p", tree: { $className: "DataModel" } });

		await expect(runAsync(rojo, projectJson)).resolves.toBe(projectJson);
	});

	it.for([
		["a non-object project", "null"],
		["a project with no tree", '{"name":"p"}'],
		["a project whose ServerStorage is not a node", '{"tree":{"ServerStorage":7}}'],
		["a project with no stage", '{"tree":{"ServerStorage":{}}}'],
	] as const)("should leave %s untouched", async ([, projectJson]) => {
		expect.assertions(1);

		const rojo = seed();

		await expect(runAsync(rojo, projectJson)).resolves.toBe(projectJson);
	});

	it("should leave a stage whose mounts declare no pinned class untouched", async () => {
		expect.assertions(1);

		const rojo = seed({ [path.join(ASSETS, "src/init.luau")]: "" });
		const projectJson = stagedProject({
			pkg: { $className: "Folder", src: { $path: path.join(ASSETS, "src") } },
		});

		await expect(runAsync(rojo, projectJson)).resolves.toBe(projectJson);
	});

	it("should point a mount that is itself a pinned model at the stand-in", async () => {
		expect.assertions(2);

		const model = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		const rojo = seed({ [model]: serviceModelXml("StarterPlayerScripts") });

		const project = await demoteAsync(
			rojo,
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
		const rojo = seed({ [model]: serviceModelXml("StarterPlayerScripts") });
		const project = await demoteAsync(
			rojo,
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

		const [, buildArgs] = rojo.execFile.mock.calls[0]!;
		const [, projectFile, , shadowFile] = buildArgs;

		expect({
			project: JSON.parse(String(rojo.volume.readFileSync(String(projectFile), "utf-8"))),
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

		const rojo = seed({
			[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts.rbxmx")]:
				serviceModelXml("StarterPlayerScripts"),
		});

		const project = await demoteAsync(
			rojo,
			directoryMount("StarterPlayer", { directory: path.join(ASSETS, "StarterPlayer") }),
		);

		// The auto-mount stays, less the one entry the stand-in replaces.
		expect(mountOf(project, "pkg", "StarterPlayer")).toBe(path.join(ASSETS, "StarterPlayer"));
		expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
			"pinned-shadow",
		);
		expect(project.globIgnorePaths![0]).toContain("StarterPlayerScripts.rbxmx");
	});

	it.for(["aaa.luau", "aaa/init.luau"])(
		"should read pinned metadata after sibling %s",
		async (sibling) => {
			expect.assertions(1);

			const rojo = seed({
				[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts", sibling)]: "return 1",
				[path.join(ASSETS, "StarterPlayer/StarterPlayerScripts/init.meta.json")]:
					'{"className":"StarterPlayerScripts"}',
			});

			const project = await demoteAsync(
				rojo,
				directoryMount("StarterPlayer", { directory: path.join(ASSETS, "StarterPlayer") }),
			);

			expect(mountOf(project, "pkg", "StarterPlayer", "StarterPlayerScripts")).toContain(
				"pinned-shadow",
			);
		},
	);

	it("should point a mount whose own init.meta.json declares the class at the stand-in", async () => {
		expect.assertions(2);

		const rojo = seed({
			[path.join(ASSETS, "SPS/init.meta.json")]: '{"className":"StarterPlayerScripts"}',
			[path.join(ASSETS, "SPS/mod.luau")]: "return 1",
		});

		const project = await demoteAsync(
			rojo,
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

		const shadow = await demotedScriptsShadowAsync();

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

		const shadow = await demotedScriptsShadowAsync();

		// Stripping after the class fold would reach this one too: by then the
		// rewritten root also reads `Folder`, and nothing tells them apart.
		expect(shadow).toContain('<int64 name="SourceAssetId">99</int64>');
	});

	it("should discard non-string globIgnorePaths entries", async () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		const rojo = seed({ [model]: serviceModelXml("Terrain") });
		const projectJson = stagedProject(
			{ pkg: { $className: "Folder", Terrain: { $path: model } } },
			fromAny([false, 42, "**/Workspace/Terrain.rbxmx"]),
		);

		await expect(runAsync(rojo, projectJson)).resolves.toBe(projectJson);
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

			const rojo = seed({
				[path.join(ASSETS, "StarterPlayer", fileName)]: contents,
			});

			const project = await demoteAsync(
				rojo,
				directoryMount("StarterPlayer", { directory: path.join(ASSETS, "StarterPlayer") }),
			);

			expect(staged(project, "pkg", "StarterPlayer", instanceName)).toBeDefined();
		},
	);
});
