import { type } from "arktype";
import * as path from "node:path";
import type { Except } from "type-fest";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath, posixRoot } from "#test/mocks/posix-path.ts";
import { configErrorLike } from "#test/mocks/run-config-error.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { PackageDescriptor } from "./synthesizer-types.ts";
import { synthesize } from "./synthesizer.ts";

const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;
const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");

function projectJson(json: JSONObject): string {
	return JSON.stringify(json);
}

// Rojo tree nodes are keyed by arbitrary instance/service names dictated by
// the fixture's project.json — not declared properties — so they're read
// through one owned schema (@isentinel/rojo-utils' RojoTreeNode) rather than
// ad-hoc inline cast types per test.
const rojoTreeNodeSchema = type({
	"[string]": "unknown",
}).as<RojoTreeNode>();

interface SynthesizedResult extends Record<string, unknown> {
	tree: RojoTreeNode;
}

const synthesizedResultSchema = type({
	"[string]": "unknown",
	"tree": "object",
}).as<SynthesizedResult>();

type MemoryFileSystem = ReturnType<typeof createMemoryFileSystem>["fileSystem"];

type FooOverrides = Partial<
	Except<PackageDescriptor, "name" | "packageDirectory" | "rojoProjectPath">
>;
function parseFixture(json: string): SynthesizedResult {
	return synthesizedResultSchema.assert(JSON.parse(json));
}

function emptyProject(name: string, globIgnorePaths?: Array<JSONValue>): string {
	const tree = { $className: "DataModel" };
	return projectJson(
		globIgnorePaths === undefined ? { name, tree } : { name, globIgnorePaths, tree },
	);
}

function fooProject(tree: JSONObject): Record<string, string> {
	return {
		[FOO_PROJECT]: projectJson({
			name: "foo-test",
			tree: { $className: "DataModel", ...tree },
		}),
	};
}

function synthesizeFoo(fileSystem: MemoryFileSystem, overrides: FooOverrides = {}): string {
	return synthesize({
		fileSystem,
		packages: [
			{
				name: "@halcyon/foo",
				...overrides,
				packageDirectory: FOO_DIR,
				rojoProjectPath: FOO_PROJECT,
			},
		],
	});
}

function synthesizeFooBar(fileSystem: MemoryFileSystem, barProject: string): string {
	return synthesize({
		fileSystem,
		packages: [
			{
				name: "@halcyon/foo",
				packageDirectory: FOO_DIR,
				rojoProjectPath: FOO_PROJECT,
			},
			{
				name: "@halcyon/bar",
				packageDirectory: path.dirname(barProject),
				rojoProjectPath: barProject,
			},
		],
	});
}

function synthesizeFooUnwrapped(fileSystem: MemoryFileSystem): string {
	return synthesize({
		fileSystem,
		packages: [{ packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT }],
		wrap: false,
	});
}

function synthesizeShadowedPackage(packagePath: string): {
	parsed: SynthesizedResult;
	shadowOut: string;
} {
	const { fileSystem, volume } = createMemoryFileSystem();
	const shadowOut = posixPath(
		path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
	);
	volume.fromJSON({
		...fooProject({ ReplicatedStorage: { Pkg: { $path: packagePath } } }),
		[path.join(FOO_DIR, "out/init.luau")]: "",
	});
	const result = synthesizeFoo(fileSystem, {
		coverageRoots: [{ luauRoot: posixRoot("out"), shadowDir: shadowOut }],
	});
	return { parsed: parseFixture(result), shadowOut };
}

function subdirectoryProjectFixture(): {
	fileSystem: MemoryFileSystem;
	shadowDirectory: string;
	subProject: string;
} {
	const { fileSystem, volume } = createMemoryFileSystem();
	const subProject = path.join(FOO_DIR, "config/dev.project.json");
	const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/out");
	volume.fromJSON({
		[path.join(FOO_DIR, "out/init.luau")]: "",
		[subProject]: projectJson({
			name: "foo-test",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: { $className: "ReplicatedStorage", $path: "../out" },
			},
		}),
	});
	return { fileSystem, shadowDirectory, subProject };
}

function normalizeSnapshotFixturePaths(json: string): string {
	const fixtureRoot = posixPath(ROOT);
	return json.replaceAll(fixtureRoot, () => fixtureRoot.replace(DRIVE_LETTER_PREFIX, ""));
}

/**
 * Reads a foreign tree-node key, validating the child is itself a node.
 * @param node - Node to read.
 * @param key - Name of the child to read.
 * @returns The child node, or `undefined` when absent.
 */
function child(node: RojoTreeNode, key: string): RojoTreeNode | undefined {
	const value = node[key];
	return value === undefined ? undefined : rojoTreeNodeSchema.assert(value);
}

/**
 * Walks a chain of foreign tree-node keys, short-circuiting on a miss.
 * @param node - Node to start from.
 * @param keys - Child keys in order.
 * @returns The node at the end of the chain, or `undefined` on a miss.
 */
function descend(node: RojoTreeNode | undefined, ...keys: Array<string>): RojoTreeNode | undefined {
	return keys.reduce<RojoTreeNode | undefined>(
		(current, key) => (current === undefined ? undefined : child(current, key)),
		node,
	);
}

function stagedFoo(parsed: SynthesizedResult, ...keys: Array<string>): RojoTreeNode | undefined {
	return descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", ...keys);
}

describe(synthesize, () => {
	it("should nest a single package under ServerStorage.__pkg_stage.<name>", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem);

		// The synthesized project is consumed as an exact Rojo artifact. Keep a
		// readable structural contract below and pin the complete representation.
		expect(normalizeSnapshotFixturePaths(result)).toMatchSnapshot();

		const parsed = JSON.parse(result);

		expect(parsed).toMatchObject({
			tree: {
				$className: "DataModel",
				ServerStorage: {
					__pkg_stage: {
						"$className": "Folder",
						"@halcyon/foo": {
							$className: "Folder",
						},
					},
				},
			},
		});

		// Service-class node at non-root → Folder.
		const { tree } = parseFixture(result);

		expect(
			descend(tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", "ReplicatedStorage")!
				.$className,
		).toBe("Folder");
	});

	it("should hardcode LoadStringEnabled at synth root", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: emptyProject("foo-test"),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = JSON.parse(result);

		expect(parsed).toMatchObject({
			tree: {
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: true },
				},
			},
		});
	});

	it("should drop $properties entirely when only service-only props remain", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: true },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "ServerScriptService")!.$properties).toBeUndefined();
	});

	it("should drop TestService-only $properties when rewriting to Folder", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				TestService: {
					$className: "TestService",
					$properties: { AutoRuns: false, ExecuteWithStudioRun: false },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "TestService")!.$properties).toBeUndefined();
	});

	it("should hoist a demoted service's $properties onto the real service", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: true, OtherProp: "kept" },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		// Rojo rejects any property on a Folder, so the staged copy keeps none.
		expect(stagedFoo(parsed, "ServerScriptService")!.$properties).toBeUndefined();

		expect(child(parsed.tree, "ServerScriptService")!.$properties).toStrictEqual({
			LoadStringEnabled: true,
			OtherProp: "kept",
		});
	});

	it("should hoist properties rojo would reject on a Folder onto the real service", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				Workspace: {
					$className: "Workspace",
					$properties: { SignalBehavior: "Deferred", StreamingEnabled: true },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);
		const workspace = child(parsed.tree, "Workspace")!;

		expect(workspace.$className).toBe("Workspace");
		expect(workspace.$properties).toStrictEqual({
			SignalBehavior: "Deferred",
			StreamingEnabled: true,
		});
	});

	it("should hoist DataModel root $properties onto the synthesized root", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel", $properties: { Name: "renamed" } },
			}),
		});

		const result = synthesizeFoo(fileSystem);

		expect(parseFixture(result).tree.$properties).toStrictEqual({
			Name: "renamed",
		});
	});

	it("should hoist a nested service's $properties onto a nested real service", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				StarterPlayer: {
					$className: "StarterPlayer",
					Scripts: {
						$className: "StarterPlayerScripts",
						$properties: { LoadCharacterAppearance: false },
					},
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);
		const scripts = descend(parsed.tree, "StarterPlayer", "Scripts")!;

		expect(child(parsed.tree, "StarterPlayer")!.$className).toBe("StarterPlayer");
		expect(scripts.$className).toBe("StarterPlayerScripts");
		expect(scripts.$properties).toStrictEqual({
			LoadCharacterAppearance: false,
		});
	});

	it("should demote a service outside the name set when it sits at the place root", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				StarterGui: {
					$className: "StarterGui",
					$properties: { ShowDevelopmentGui: false },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "StarterGui")!.$className).toBe("Folder");
		expect(child(parsed.tree, "StarterGui")!.$properties).toStrictEqual({
			ShowDevelopmentGui: false,
		});
	});

	it("should add $className Folder to a bare node named after a service outside the set", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			// Rojo infers StarterGui from the name at the root; nested under
			// __pkg_stage it would be rejected as missing required information.
			...fooProject({
				StarterGui: { Pkg: { $path: "src" } },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "StarterGui")!.$className).toBe("Folder");
	});

	it("should leave $properties in place on a node that was never demoted", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					Config: {
						$className: "Configuration",
						$properties: { AutoRuns: true, Name: "Config" },
					},
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);
		const config = stagedFoo(parsed, "ReplicatedStorage", "Config")!;

		// Not a service, so nothing is filtered out of it and nothing is hoisted.
		expect(config.$className).toBe("Configuration");
		expect(config.$properties).toStrictEqual({
			AutoRuns: true,
			Name: "Config",
		});
	});

	it("should merge hoisted properties from different packages", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		volume.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$className: "Workspace",
						$properties: { StreamingEnabled: true },
					},
				},
			}),
			...fooProject({
				Workspace: {
					$className: "Workspace",
					$properties: { SignalBehavior: "Deferred" },
				},
			}),
		});

		const result = synthesizeFooBar(fileSystem, barProject);

		expect(child(parseFixture(result).tree, "Workspace")!.$properties).toStrictEqual({
			SignalBehavior: "Deferred",
			StreamingEnabled: true,
		});
	});

	it("should mark the stage when a package asks for non-legacy scripts", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				emitLegacyScripts: false,
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		// The flag itself must not reach the place: a RunContext script would
		// run from the stage at place load.
		expect(parsed["emitLegacyScripts"]).toBeUndefined();
		expect(stagedFoo(parsed)!["$attributes"]).toStrictEqual({
			JestRunContextScripts: true,
		});
	});

	it("should leave the stage unmarked when a package asks for legacy scripts", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				emitLegacyScripts: true,
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesizeFoo(fileSystem);

		expect(
			descend(parseFixture(result).tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")![
				"$attributes"
			],
		).toBeUndefined();
	});

	it("should leave the stage unmarked when a package declares nothing", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: emptyProject("foo-test"),
		});

		const result = synthesizeFoo(fileSystem);

		expect(
			descend(parseFixture(result).tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")![
				"$attributes"
			],
		).toBeUndefined();
	});

	it("should keep a package's own $attributes when marking the stage", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				emitLegacyScripts: false,
				tree: { $attributes: { Existing: "kept" }, $className: "DataModel" },
			}),
		});

		const result = synthesizeFoo(fileSystem);

		expect(
			descend(parseFixture(result).tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")![
				"$attributes"
			],
		).toStrictEqual({ Existing: "kept", JestRunContextScripts: true });
	});

	it("should carry globIgnorePaths when every declaring package agrees", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		volume.fromJSON({
			// bar declares nothing, so it has no opinion and does not constrain
			// foo.
			[barProject]: emptyProject("bar-test"),
			[FOO_PROJECT]: emptyProject("foo-test", ["**/tsconfig.json", "**/*.cov-map.*"]),
		});

		const result = synthesizeFooBar(fileSystem, barProject);

		expect(parseFixture(result)["globIgnorePaths"]).toStrictEqual([
			"**/tsconfig.json",
			"**/*.cov-map.*",
		]);
	});

	it("should omit globIgnorePaths when no package declares any", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: emptyProject("foo-test"),
		});

		const result = synthesizeFoo(fileSystem);

		expect(parseFixture(result)["globIgnorePaths"]).toBeUndefined();
	});

	it("should ignore non-string entries in a declared globIgnorePaths", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: emptyProject("foo-test", ["**/tsconfig.json", 42]),
		});

		const result = synthesizeFoo(fileSystem);

		expect(parseFixture(result)["globIgnorePaths"]).toStrictEqual(["**/tsconfig.json"]);
	});

	it("should throw ConfigError when packages declare different globIgnorePaths", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		volume.fromJSON({
			[barProject]: emptyProject("bar-test", ["**/out/**"]),
			[FOO_PROJECT]: emptyProject("foo-test", ["**/tsconfig.json"]),
		});

		expect(() => {
			synthesize({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
					{
						name: "@halcyon/bar",
						packageDirectory: path.dirname(barProject),
						rojoProjectPath: barProject,
					},
				],
			});
		}).toThrow(
			configErrorLike(
				"workspace packages disagree on `globIgnorePaths`.\n\n" +
					'  - ["**/tsconfig.json"] — declared by @halcyon/foo\n' +
					'  - ["**/out/**"] — declared by @halcyon/bar\n\n' +
					"Every package in a workspace run shares one synthesized place, so one\n" +
					"ignore list covers every mount in it. Either align the list across each\n" +
					"package's rojo project, or run the odd package on its own.",
			),
		);
	});

	it("should accept the same globIgnorePaths listed in a different order", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		volume.fromJSON({
			[barProject]: emptyProject("bar-test", ["**/*.cov-map.*", "**/tsconfig.json"]),
			[FOO_PROJECT]: emptyProject("foo-test", ["**/tsconfig.json", "**/*.cov-map.*"]),
		});

		const result = synthesizeFooBar(fileSystem, barProject);

		expect(parseFixture(result)["globIgnorePaths"]).toStrictEqual([
			"**/tsconfig.json",
			"**/*.cov-map.*",
		]);
	});

	it("should merge hoisted properties into a service the synth root already declares", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ServerStorage: {
					$className: "ServerStorage",
					$properties: { Name: "kept" },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		const serverStorage = child(parseFixture(result).tree, "ServerStorage")!;

		// The stage lives on ServerStorage, so the hoist has to merge rather than
		// replace the node the synthesizer built.
		expect(serverStorage.$properties).toStrictEqual({ Name: "kept" });
		expect(serverStorage["__pkg_stage"]).toBeDefined();
	});

	it("should keep LoadStringEnabled on when a package declares it off", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: false },
				},
			}),
		});

		const result = synthesizeFoo(fileSystem);

		expect(child(parseFixture(result).tree, "ServerScriptService")!.$properties).toStrictEqual({
			LoadStringEnabled: true,
		});
	});

	it.for([
		"Players",
		"DataModel",
		"ReplicatedFirst",
		"ReplicatedStorage",
		"ServerScriptService",
		"ServerStorage",
		"Teams",
		"TextChatService",
		"LocalizationService",
		"RunService",
		"CollectionService",
		"TweenService",
		"Chat",
		"HttpService",
		"MarketplaceService",
		"MaterialService",
		"MessagingService",
		"UserInputService",
		"TestService",
		"Lighting",
		"SoundService",
		"StarterCharacterScripts",
		"StarterGui",
		"StarterPack",
		"StarterPlayer",
		"StarterPlayerScripts",
		"Terrain",
		"Workspace",
	])("should rewrite pinned class %s to Folder when nested", (serviceClass) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				[serviceClass]: { $className: serviceClass, $path: "src" },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, serviceClass)!.$className).toBe("Folder");
	});

	it.for([
		["StarterPlayer", "StarterPlayerScripts"],
		["StarterPlayer", "StarterCharacterScripts"],
		["Workspace", "Terrain"],
	] as const)(
		"should rewrite %s.%s to Folder — the engine pins the class to one parent",
		([parent, pinned]) => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					[parent]: {
						$className: parent,
						[pinned]: { $className: pinned, $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
			});

			expect(
				descend(
					parseFixture(result).tree,
					"ServerStorage",
					"__pkg_stage",
					"@halcyon/foo",
					parent,
					pinned,
				)!.$className,
			).toBe("Folder");
		},
	);

	it("should add $className Folder to an implicit service node (no $className) when nested", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			// Rojo infers a service from the node name at the DataModel root, so
			// ServerScriptService carries no $className here (Nevermore layout).
			// Once relocated under __pkg_stage it needs an explicit one.
			...fooProject({
				ServerScriptService: {
					Pkg: { $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "ServerScriptService")!.$className).toBe("Folder");
	});

	it("should not add $className to an implicit service node that already carries a $path", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			// A bare service node with $path and no $className: Rojo mounts the
			// path, so the synthesizer must not override it with a Folder class.
			...fooProject({
				ServerScriptService: { $path: "src" },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem);

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "ServerScriptService")!.$className).toBeUndefined();
	});

	it("should isolate per-package service roots even when packages claim the same service", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		volume.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			...fooProject({
				ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[path.join(ROOT, "packages/bar/src/init.luau")]: "",
		});

		const result = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: path.join(ROOT, "packages/bar"),
					rojoProjectPath: barProject,
				},
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/bar",
				"ReplicatedStorage",
			)!.$path,
		).toBe(posixPath(path.join(ROOT, "packages/bar/src")));
		expect(stagedFoo(parsed, "ReplicatedStorage")!.$path).toBe(
			posixPath(path.join(FOO_DIR, "src")),
		);
	});

	it("should keep stubMounts isolated per package", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		const barDirectory = path.join(ROOT, "packages/bar");
		const stubFoo = path.join(ROOT, ".cache/foo/jest.config.luau");
		const stubBar = path.join(ROOT, ".cache/bar/jest.config.luau");
		volume.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						BarMount: { $path: "src" },
					},
				},
			}),
			...fooProject({
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					FooMount: { $path: "src" },
				},
			}),
			[path.join(barDirectory, "src/init.luau")]: "",
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[stubBar]: "return {}",
			[stubFoo]: "return {}",
		});

		const result = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: barDirectory,
					rojoProjectPath: barProject,
					stubMounts: [
						{
							absStubPath: stubBar,
							dataModelPath: "ReplicatedStorage/BarMount",
						},
					],
				},
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubFoo,
							dataModelPath: "ReplicatedStorage/FooMount",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const stage = descend(parsed.tree, "ServerStorage", "__pkg_stage");

		expect(
			descend(stage, "@halcyon/bar", "ReplicatedStorage", "BarMount", "jest.config")!.$path,
		).toBe(stubBar.replaceAll("\\", "/"));
		expect(
			descend(stage, "@halcyon/foo", "ReplicatedStorage", "FooMount", "jest.config")!.$path,
		).toBe(stubFoo.replaceAll("\\", "/"));
	});

	it("should propagate coverage shadow dir through a virtualized $path child", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const shadowOut = posixPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out-test"),
		);

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		volume.fromJSON({
			...fooProject({
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					Tests: { $path: "out-test" },
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(shadowOut, "src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: posixRoot("out-test"), shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubPath,
							dataModelPath: "ReplicatedStorage/Tests/src",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const tests = stagedFoo(parsed, "ReplicatedStorage", "Tests");

		// Parent demoted (no $path) so rojo doesn't auto-mount a duplicate `src`
		// alongside the explicit overlay; the shadowed prefix is carried on the
		// explicit child instead.
		expect(tests!.$path).toBeUndefined();
		expect(descend(tests, "src")!.$path).toBe(`${shadowOut}/src`);
	});

	it.for(["jest.config.lua", "jest.config.luau"])(
		"should leave a %s in a virtualized leaf source dir out of the place",
		(collidingFile) => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");

			const sourceDirectory = path.join(FOO_DIR, "out-test/src");
			volume.fromJSON({
				...fooProject({
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				}),
				[path.join(sourceDirectory, "init.luau")]: "",
				[path.join(sourceDirectory, collidingFile)]: "return {}",
				[stubPath]: "return {}",
			});

			function callSynthesize(): string {
				return synthesize({
					fileSystem,
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [
								{
									absStubPath: stubPath,
									dataModelPath: "ReplicatedStorage/Tests/src",
								},
							],
						},
					],
				});
			}

			const parsed = parseFixture(callSynthesize());

			expect(parsed["globIgnorePaths"]).toStrictEqual([
				path.join(sourceDirectory, collidingFile).replaceAll("\\", "/"),
			]);
			expect(
				descend(stagedFoo(parsed, "ReplicatedStorage", "Tests", "src"), "jest.config")!
					.$path,
			).toBe(stubPath.replaceAll("\\", "/"));
		},
	);

	it("should produce identical output to a stubMounts-less descriptor when stubMounts is an empty array", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			...fooProject({
				ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const baseline = synthesizeFoo(fileSystem);
		const withEmpty = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [],
				},
			],
		});

		expect(withEmpty).toBe(baseline);
	});

	it("should swap $path to the per-package coverage shadow dir when coverageRoots is set", () => {
		expect.assertions(1);

		const { parsed, shadowOut } = synthesizeShadowedPackage("out");

		expect(stagedFoo(parsed, "ReplicatedStorage", "Pkg")!.$path).toBe(shadowOut);
	});

	it("should leave $path untouched for packages that opt out of coverageRoots", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		const fooShadow = posixPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		volume.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			...fooProject({
				ReplicatedStorage: { Pkg: { $path: "out" } },
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
			[path.join(ROOT, "packages/bar/out/init.luau")]: "",
		});

		const result = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: path.join(ROOT, "packages/bar"),
					rojoProjectPath: barProject,
				},
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: posixRoot("out"), shadowDir: fooShadow }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/bar",
				"ReplicatedStorage",
				"Pkg",
			)!.$path,
		).toBe(posixPath(path.join(ROOT, "packages/bar/out")));
		expect(stagedFoo(parsed, "ReplicatedStorage", "Pkg")!.$path).toBe(fooShadow);
	});

	it("should pass nested $path entries through the coverage shadow dir prefix", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const shadowOut = posixPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);

		volume.fromJSON({
			...fooProject({
				ReplicatedStorage: { Client: { $path: "out/client" } },
			}),
			[path.join(FOO_DIR, "out/client/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem, {
			coverageRoots: [{ luauRoot: posixRoot("out"), shadowDir: shadowOut }],
		});

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "ReplicatedStorage", "Client")!.$path).toBe(`${shadowOut}/client`);
	});

	it("should normalize trailing slashes on $path before matching coverageRoots", () => {
		expect.assertions(1);

		const { parsed, shadowOut } = synthesizeShadowedPackage("out/");

		// Must NOT have a trailing slash → not "<shadowOut>/".
		expect(stagedFoo(parsed, "ReplicatedStorage", "Pkg")!.$path).toBe(shadowOut);
	});

	it("should leave $path entries that don't match any coverageRoot using package-relative resolution", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const shadowOut = posixPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);

		volume.fromJSON({
			...fooProject({
				ReplicatedStorage: { Other: { $path: "vendor" } },
			}),
			[path.join(FOO_DIR, "vendor/init.luau")]: "",
		});

		const result = synthesizeFoo(fileSystem, {
			coverageRoots: [{ luauRoot: posixRoot("out"), shadowDir: shadowOut }],
		});

		const parsed = parseFixture(result);

		expect(stagedFoo(parsed, "ReplicatedStorage", "Other")!.$path).toBe(
			posixPath(path.join(FOO_DIR, "vendor")),
		);
	});

	it("should be byte-stable regardless of input package ordering", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");

		volume.fromJSON({
			[barProject]: emptyProject("bar-test"),
			[FOO_PROJECT]: emptyProject("foo-test"),
		});

		const ordered = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: ROOT,
					rojoProjectPath: barProject,
				},
				{
					name: "@halcyon/foo",
					packageDirectory: ROOT,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});
		const reversed = synthesize({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: ROOT,
					rojoProjectPath: FOO_PROJECT,
				},
				{
					name: "@halcyon/bar",
					packageDirectory: ROOT,
					rojoProjectPath: barProject,
				},
			],
		});

		expect(ordered).toBe(reversed);
	});

	it("should stamp the place content id in wrap mode too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[FOO_PROJECT]: emptyProject("foo-test"),
		});

		const result = synthesize({
			contentId: "deadbeef",
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const stamp = descend(parseFixture(result).tree, "ReplicatedStorage", "__place_content_id");

		expect(stamp!.$properties!["Value"]).toBe("deadbeef");
	});

	describe("no-wrap mode (single-package coverage)", () => {
		it("should return the package's project tree without ServerStorage.__pkg_stage wrap", () => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$className).toBe("ReplicatedStorage");
			expect(descend(parsed.tree, "ServerStorage", "__pkg_stage")).toBeUndefined();
		});

		it("should inject ServerScriptService.LoadStringEnabled when loadStringEnabled is set", () => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				loadStringEnabled: true,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);
			const serverScriptService = child(parsed.tree, "ServerScriptService");

			expect(serverScriptService!.$className).toBe("ServerScriptService");
			expect(serverScriptService!.$properties!["LoadStringEnabled"]).toBeTrue();
		});

		it("should merge LoadStringEnabled into an existing ServerScriptService, keeping its $path and props", () => {
			expect.assertions(3);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ServerScriptService: {
						$className: "ServerScriptService",
						$path: "server",
						$properties: { OtherProp: "kept" },
					},
				}),
				[path.join(FOO_DIR, "server/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				loadStringEnabled: true,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);
			const serverScriptService = child(parsed.tree, "ServerScriptService");

			expect(serverScriptService!.$properties!["LoadStringEnabled"]).toBeTrue();
			expect(serverScriptService!.$properties!["OtherProp"]).toBe("kept");
			expect(serverScriptService!.$path).toContain("server");
		});

		it("should stamp the place content id where a booted task can read it", () => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				contentId: "deadbeef",
				fileSystem,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const stamp = descend(
				parseFixture(result).tree,
				"ReplicatedStorage",
				"__place_content_id",
			);

			expect(stamp!.$className).toBe("StringValue");
			expect(stamp!.$properties!["Value"]).toBe("deadbeef");
		});

		it("should stamp into a ReplicatedStorage the project never declared", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[FOO_PROJECT]: emptyProject("foo-test"),
			});

			const result = synthesize({
				contentId: "deadbeef",
				fileSystem,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const replicatedStorage = child(parseFixture(result).tree, "ReplicatedStorage");

			expect(replicatedStorage!.$className).toBe("ReplicatedStorage");
		});

		it("should give an implicit existing ServerScriptService its canonical class", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ServerScriptService: { Existing: { $className: "Folder" } },
				}),
			});

			const result = synthesize({
				fileSystem,
				loadStringEnabled: true,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			expect(child(parseFixture(result).tree, "ServerScriptService")!.$className).toBe(
				"ServerScriptService",
			);
		});

		it("should tolerate a malformed null $properties on ServerScriptService", () => {
			// `typeof null === "object"`, so an unguarded property check would
			// treat null as a record and `Object.entries(null)` would throw.
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ServerScriptService: {
						$className: "ServerScriptService",
						$path: "server",
						$properties: null,
					},
				}),
				[path.join(FOO_DIR, "server/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				loadStringEnabled: true,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(
				child(parsed.tree, "ServerScriptService")!.$properties!["LoadStringEnabled"],
			).toBeTrue();
		});

		it("should not inject ServerScriptService when loadStringEnabled is unset", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			const parsed = parseFixture(result);

			expect(parsed.tree["ServerScriptService"]).toBeUndefined();
		});

		it("should preserve all top-level project fields (gameId, placeId, globIgnorePaths, servePort, name)", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					gameId: 99,
					globIgnorePaths: ["**/foo.txt"],
					placeId: 100,
					servePort: 12345,
					tree: { $className: "DataModel" },
				}),
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			expect(JSON.parse(result)).toMatchObject({
				name: "foo-test",
				gameId: 99,
				globIgnorePaths: ["**/foo.txt"],
				placeId: 100,
				servePort: 12345,
			});
		});

		it("should absolutize $path entries against path.dirname(rojoProjectPath)", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$path).toBe(
				posixPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should rebase the $path of a child named optional", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						optional: { $path: "src" },
					},
				}),
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			expect(descend(parseFixture(result).tree, "ReplicatedStorage", "optional")!.$path).toBe(
				posixPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should leave an attribute named optional as written", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: {
						$attributes: { optional: "src" },
						$className: "ReplicatedStorage",
					},
				}),
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			expect(
				child(parseFixture(result).tree, "ReplicatedStorage")!["$attributes"],
			).toStrictEqual({ optional: "src" });
		});

		it("should redirect the inner path of an optional $path under coverageRoots[].luauRoot", () => {
			expect.assertions(1);

			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/src");
			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						$path: { optional: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				packages: [
					{
						coverageRoots: [{ luauRoot: posixRoot("src"), shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			expect(child(parseFixture(result).tree, "ReplicatedStorage")!.$path).toStrictEqual({
				optional: posixPath(shadowDirectory),
			});
		});

		it("should redirect $path entries under coverageRoots[].luauRoot to the shadow directory", () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/src");

			volume.fromJSON({
				...fooProject({
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				packages: [
					{
						coverageRoots: [{ luauRoot: posixRoot("src"), shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$path).toBe(posixPath(shadowDirectory));
		});

		it("should redirect coverageRoots[].luauRoot resolved against packageDirectory when rojoProject sits in a subdirectory", () => {
			expect.assertions(1);

			const { fileSystem, shadowDirectory, subProject } = subdirectoryProjectFixture();

			const result = synthesize({
				fileSystem,
				packages: [
					{
						coverageRoots: [{ luauRoot: posixRoot("out"), shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: subProject,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$path).toBe(posixPath(shadowDirectory));
		});
	});

	describe("wrap mode (workspace) dual-base resolution", () => {
		it("should redirect coverageRoots[].luauRoot resolved against packageDirectory when rojoProject sits in a subdirectory", () => {
			expect.assertions(1);

			const { fileSystem, shadowDirectory, subProject } = subdirectoryProjectFixture();

			const result = synthesize({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [{ luauRoot: posixRoot("out"), shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: subProject,
					},
				],
			});

			const parsed = parseFixture(result);

			expect(stagedFoo(parsed, "ReplicatedStorage")!.$path).toBe(posixPath(shadowDirectory));
		});
	});

	describe("no-wrap mode validation", () => {
		it("should throw ConfigError when wrap=false with zero packages", () => {
			expect.assertions(1);

			expect(() => synthesize({ packages: [], wrap: false })).toThrow(
				configErrorLike("synthesize wrap:false requires exactly one package, got 0"),
			);
		});

		it("should resolve nested .project.json mounts in no-wrap mode", () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const nestedProject = path.join(FOO_DIR, "nested.project.json");

			volume.fromJSON({
				...fooProject({
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Common: { $path: "nested.project.json" },
					},
				}),
				[nestedProject]: projectJson({
					name: "nested-test",
					tree: {
						$className: "Folder",
						Sub: { $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesizeFooUnwrapped(fileSystem);

			const parsed = parseFixture(result);

			expect(descend(parsed.tree, "ReplicatedStorage", "Common", "Sub")!.$path).toBe(
				posixPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should throw ConfigError when wrap=false with more than one package", () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const barProject = path.join(ROOT, "packages/bar/test.project.json");

			volume.fromJSON({
				[barProject]: emptyProject("bar-test"),
				[FOO_PROJECT]: emptyProject("foo-test"),
			});

			expect(() => {
				return synthesize({
					fileSystem,
					packages: [
						{
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
						},
						{
							packageDirectory: path.join(ROOT, "packages/bar"),
							rojoProjectPath: barProject,
						},
					],
					wrap: false,
				});
			}).toThrow(configErrorLike());
		});

		// Multi-project + open-cloud wire shape: synthesizer must produce a
		// place-buildable project.json from a single user package with
		// multiple project mounts and stubs in the cache.
		it("should add a user config at a stub mount to the declared globIgnorePaths", () => {
			expect.assertions(2);

			const stubPath = path.join(FOO_DIR, ".jest-roblox/cache/out/Shared/jest.config.luau");
			const userConfig = path.join(FOO_DIR, "out/Shared/jest.config.luau");
			const { fileSystem } = createMemoryFileSystem({
				[FOO_PROJECT]: projectJson({
					name: "user-game",
					globIgnorePaths: ["**/*.txt"],
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Shared: { $path: "out/Shared" },
						},
					},
				}),
				[stubPath]: "return {}",
				[userConfig]: "return { placeId = '1' }",
			});

			const parsed = parseFixture(
				synthesize({
					fileSystem,
					packages: [
						{
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [
								{
									absStubPath: stubPath,
									dataModelPath: "ReplicatedStorage/Shared",
								},
							],
						},
					],
					wrap: false,
				}),
			);

			expect(parsed["globIgnorePaths"]).toStrictEqual([
				"**/*.txt",
				userConfig.replaceAll("\\", "/"),
			]);
			expect(descend(parsed.tree, "ReplicatedStorage", "Shared", "jest.config")!.$path).toBe(
				stubPath.replaceAll("\\", "/"),
			);
		});

		it("should produce a place-ready synthesized project for multi-project + open-cloud shape", () => {
			expect.assertions(5);

			const { fileSystem } = createMemoryFileSystem({
				[FOO_PROJECT]: projectJson({
					name: "user-game",
					gameId: 4242,
					placeId: 9999,
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Shared: { $path: "out/Shared" },
						},
						ServerStorage: {
							$className: "ServerStorage",
							Server: { $path: "out/Server" },
						},
					},
				}),
				[path.join(FOO_DIR, ".jest-roblox/cache/server/jest.config.luau")]:
					"-- @generated by jest-roblox\nreturn {}",
				[path.join(FOO_DIR, ".jest-roblox/cache/shared/jest.config.luau")]:
					"-- @generated by jest-roblox\nreturn {}",
				[path.join(FOO_DIR, "out/Server/init.luau")]: "",
				[path.join(FOO_DIR, "out/Shared/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: path.join(
									FOO_DIR,
									".jest-roblox/cache/shared/jest.config.luau",
								),
								dataModelPath: "ReplicatedStorage/Shared",
							},
							{
								absStubPath: path.join(
									FOO_DIR,
									".jest-roblox/cache/server/jest.config.luau",
								),
								dataModelPath: "ServerStorage/Server",
							},
						],
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			// Top-level user fields preserved.
			expect(parsed).toMatchObject({
				name: "user-game",
				gameId: 4242,
				placeId: 9999,
			});
			expect(normalizeSnapshotFixturePaths(result)).toMatchSnapshot();

			// Both project mounts retained with stubs injected as named children.
			expect(descend(parsed.tree, "ReplicatedStorage", "Shared")!.$path).toContain("out");
			expect(
				descend(parsed.tree, "ReplicatedStorage", "Shared", "jest.config")!.$path,
			).toContain("shared");
			expect(descend(parsed.tree, "ServerStorage", "Server", "jest.config")!.$path).toContain(
				"server",
			);
		});

		it("should not error when wrapped packages share one leaf and stub", () => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({
				...fooProject({
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						$path: "out-test",
					},
				}),
			});
			const mount = {
				absStubPath: path.join(FOO_DIR, ".jest-roblox/jest.config.luau"),
				dataModelPath: "ReplicatedStorage",
			};

			expect(() => {
				return synthesize({
					fileSystem,
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [mount, { ...mount }, { ...mount }],
						},
					],
					wrap: true,
				});
			}).not.toThrow();
		});

		// Preservation contract: arbitrary unknown top-level keys (future
		// Rojo schema additions, user custom fields) must survive
		// `synthesize(wrap: false)` byte-for-byte, including when
		// `injectStubMounts` mutates the tree.
		it("should preserve arbitrary unknown top-level keys and nested unknown fields through stub injection", () => {
			expect.assertions(4);

			const { fileSystem } = createMemoryFileSystem({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					myFutureRojoField: { nested: { deeply: ["a", "b"] } },
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$bonusUnknownKey: "placeholder",
							$className: "ReplicatedStorage",
							$path: "src",
						},
					},
					unknownTopLevelArray: [1, 2, 3],
					unknownTopLevelString: "preserved please",
				}),
				[path.join(FOO_DIR, ".jest-roblox/jest.config.luau")]: "-- stub\nreturn {}",
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				fileSystem,
				packages: [
					{
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: path.join(FOO_DIR, ".jest-roblox/jest.config.luau"),
								dataModelPath: "ReplicatedStorage",
							},
						],
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			// Unknown top-level fields survive.
			expect(parsed).toMatchObject({
				myFutureRojoField: { nested: { deeply: ["a", "b"] } },
				unknownTopLevelArray: [1, 2, 3],
				unknownTopLevelString: "preserved please",
			});

			// Unknown $-prefixed nested key survives the absolutizePaths walk.
			const replicatedStorage = child(parsed.tree, "ReplicatedStorage");

			expect(replicatedStorage!["$bonusUnknownKey"]).toBe("placeholder");

			// Stub injection landed at the right leaf as a named child.
			const jestConfig = descend(replicatedStorage, "jest.config");

			expect(jestConfig).toBeDefined();
			expect(jestConfig!.$path).toContain("jest.config.luau");
		});
	});
});
