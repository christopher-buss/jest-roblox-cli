import { fromAny } from "@total-typescript/shoehorn";

import { type, type Type } from "arktype";
import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/errors.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { synthesize } from "./synthesizer.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");

function projectJson(json: object): string {
	return String(JSON.stringify(json));
}

// Rojo tree nodes are keyed by arbitrary instance/service names dictated by
// the fixture's project.json — not declared properties — so they're read
// through one owned schema (@isentinel/rojo-utils' RojoTreeNode) rather than
// ad-hoc inline cast types per test.
const rojoTreeNodeSchema: Type<RojoTreeNode> = type({
	"[string]": "unknown",
}).as<RojoTreeNode>();

interface SynthesizedResult extends Record<string, unknown> {
	tree: RojoTreeNode;
}

const synthesizedResultSchema: Type<SynthesizedResult> = type({
	"[string]": "unknown",
	"tree": "object",
}).as<SynthesizedResult>();

function parseFixture(json: string): SynthesizedResult {
	return synthesizedResultSchema.assert(JSON.parse(json));
}

/** Reads a foreign tree-node key, validating the child is itself a node. */
function child(node: RojoTreeNode, key: string): RojoTreeNode | undefined {
	const value = node[key];
	return value === undefined ? undefined : rojoTreeNodeSchema.assert(value);
}

/** Walks a chain of foreign tree-node keys, short-circuiting on a miss. */
function descend(node: RojoTreeNode | undefined, ...keys: Array<string>): RojoTreeNode | undefined {
	return keys.reduce<RojoTreeNode | undefined>(
		(current, key) => (current === undefined ? undefined : child(current, key)),
		node,
	);
}

describe(synthesize, () => {
	it("should nest a single package under ServerStorage.__pkg_stage.<name>", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

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

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

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

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						$className: "ServerScriptService",
						$properties: { LoadStringEnabled: true },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
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
				"@halcyon/foo",
				"ServerScriptService",
			)!.$properties,
		).toBeUndefined();
	});

	it("should drop TestService-only $properties when rewriting to Folder", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					TestService: {
						$className: "TestService",
						$properties: { AutoRuns: false, ExecuteWithStudioRun: false },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", "TestService")!
				.$properties,
		).toBeUndefined();
	});

	it("should hoist a demoted service's $properties onto the real service", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						$className: "ServerScriptService",
						$properties: { LoadStringEnabled: true, OtherProp: "kept" },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		// Rojo rejects any property on a Folder, so the staged copy keeps none.
		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/foo",
				"ServerScriptService",
			)!.$properties,
		).toBeUndefined();

		expect(child(parsed.tree, "ServerScriptService")!.$properties).toStrictEqual({
			LoadStringEnabled: true,
			OtherProp: "kept",
		});
	});

	it("should hoist properties rojo would reject on a Folder onto the real service", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$className: "Workspace",
						$properties: { SignalBehavior: "Deferred", StreamingEnabled: true },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

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

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel", $properties: { Name: "renamed" } },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(parseFixture(result).tree.$properties).toStrictEqual({ Name: "renamed" });
	});

	it("should drop root $properties for a project whose root is not a place", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-model",
				tree: { $className: "Model", $properties: { Name: "nowhere-to-go" } },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(parseFixture(result).tree.$properties).toBeUndefined();
	});

	it("should hoist a nested service's $properties onto a nested real service", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					StarterPlayer: {
						$className: "StarterPlayer",
						StarterPlayerScripts: {
							$className: "StarterPlayerScripts",
							$properties: { LoadCharacterAppearance: false },
						},
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);
		const scripts = descend(parsed.tree, "StarterPlayer", "StarterPlayerScripts")!;

		expect(child(parsed.tree, "StarterPlayer")!.$className).toBe("StarterPlayer");
		expect(scripts.$properties).toStrictEqual({ LoadCharacterAppearance: false });
	});

	it("should demote a service outside the name set when it sits at the place root", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					StarterGui: {
						$className: "StarterGui",
						$properties: { ShowDevelopmentGui: false },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", "StarterGui")!
				.$className,
		).toBe("Folder");
		expect(child(parsed.tree, "StarterGui")!.$properties).toStrictEqual({
			ShowDevelopmentGui: false,
		});
	});

	it("should add $className Folder to a bare node named after a service outside the set", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			// Rojo infers StarterGui from the name at the root; nested under
			// __pkg_stage it would be rejected as missing required information.
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					StarterGui: { Pkg: { $path: "src" } },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", "StarterGui")!
				.$className,
		).toBe("Folder");
	});

	it("should leave $properties in place on a node that was never demoted", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Config: {
							$className: "Configuration",
							$properties: { AutoRuns: true, Name: "Config" },
						},
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);
		const config = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"Config",
		)!;

		// Not a service, so nothing is filtered out of it and nothing is hoisted.
		expect(config.$className).toBe("Configuration");
		expect(config.$properties).toStrictEqual({ AutoRuns: true, Name: "Config" });
	});

	it("should merge hoisted properties when packages agree on the value", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$className: "Workspace",
						$properties: { SignalBehavior: "Deferred", StreamingEnabled: true },
					},
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$className: "Workspace",
						$properties: { SignalBehavior: "Deferred" },
					},
				},
			}),
		});

		const result = synthesize({
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

		expect(child(parseFixture(result).tree, "Workspace")!.$properties).toStrictEqual({
			SignalBehavior: "Deferred",
			StreamingEnabled: true,
		});
	});

	it("should throw ConfigError when packages disagree on a hoisted property", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$className: "Workspace",
						$properties: { StreamingEnabled: false },
					},
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					Workspace: {
						$className: "Workspace",
						$properties: { StreamingEnabled: true },
					},
				},
			}),
		});

		expect(() => {
			synthesize({
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
		}).toThrow(/disagree on `Workspace\.StreamingEnabled`/);
	});

	it.for([{}, "not-an-object"])("should hoist nothing for $properties %o", (properties) => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					Workspace: { $className: "Workspace", $properties: properties },
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(child(parsed.tree, "Workspace")).toBeUndefined();
		expect(
			descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", "Workspace")!
				.$properties,
		).toBeUndefined();
	});

	it("should mark the stage when a package asks for non-legacy scripts", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				emitLegacyScripts: false,
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		// The flag itself must not reach the place: a RunContext script would
		// run from the stage at place load.
		expect(parsed["emitLegacyScripts"]).toBeUndefined();
		expect(
			descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")!["$attributes"],
		).toStrictEqual({ JestRunContextScripts: true });
	});

	it("should leave the stage unmarked when a package asks for legacy scripts", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				emitLegacyScripts: true,
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(
			descend(parseFixture(result).tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")![
				"$attributes"
			],
		).toBeUndefined();
	});

	it("should leave the stage unmarked when a package declares nothing", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({ name: "foo-test", tree: { $className: "DataModel" } }),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(
			descend(parseFixture(result).tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")![
				"$attributes"
			],
		).toBeUndefined();
	});

	it("should keep a package's own $attributes when marking the stage", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				emitLegacyScripts: false,
				tree: { $attributes: { Existing: "kept" }, $className: "DataModel" },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(
			descend(parseFixture(result).tree, "ServerStorage", "__pkg_stage", "@halcyon/foo")![
				"$attributes"
			],
		).toStrictEqual({ Existing: "kept", JestRunContextScripts: true });
	});

	it("should carry globIgnorePaths when every declaring package agrees", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			// bar declares nothing, so it has no opinion and does not constrain
			// foo.
			[barProject]: projectJson({ name: "bar-test", tree: { $className: "DataModel" } }),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				globIgnorePaths: ["**/tsconfig.json", "**/*.cov-map.*"],
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
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

		expect(parseFixture(result)["globIgnorePaths"]).toStrictEqual([
			"**/tsconfig.json",
			"**/*.cov-map.*",
		]);
	});

	it("should omit globIgnorePaths when no package declares any", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({ name: "foo-test", tree: { $className: "DataModel" } }),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(parseFixture(result)["globIgnorePaths"]).toBeUndefined();
	});

	it("should ignore non-string entries in a declared globIgnorePaths", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				globIgnorePaths: ["**/tsconfig.json", 42],
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(parseFixture(result)["globIgnorePaths"]).toStrictEqual(["**/tsconfig.json"]);
	});

	it("should throw ConfigError when packages declare different globIgnorePaths", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				globIgnorePaths: ["**/out/**"],
				tree: { $className: "DataModel" },
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				globIgnorePaths: ["**/tsconfig.json"],
				tree: { $className: "DataModel" },
			}),
		});

		expect(() => {
			synthesize({
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
		}).toThrow(/disagree on `globIgnorePaths`/);
	});

	it("should accept the same globIgnorePaths listed in a different order", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				globIgnorePaths: ["**/*.cov-map.*", "**/tsconfig.json"],
				tree: { $className: "DataModel" },
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				globIgnorePaths: ["**/tsconfig.json", "**/*.cov-map.*"],
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
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

		expect(parseFixture(result)["globIgnorePaths"]).toStrictEqual([
			"**/tsconfig.json",
			"**/*.cov-map.*",
		]);
	});

	it("should name the hoisted service after the node when it declares no class", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			// Rojo infers Workspace from the node name at the root, so the class
			// the hoisted service needs has to come from the name too.
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					Workspace: { $properties: { StreamingEnabled: true } },
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const workspace = child(parseFixture(result).tree, "Workspace")!;

		expect(workspace.$className).toBe("Workspace");
		expect(workspace.$properties).toStrictEqual({ StreamingEnabled: true });
	});

	it("should label a root property conflict against DataModel", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: { $className: "DataModel", $properties: { Name: "bar" } },
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel", $properties: { Name: "foo" } },
			}),
		});

		expect(() => {
			synthesize({
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
		}).toThrow(/disagree on `DataModel\.Name`/);
	});

	it("should merge hoisted properties into a service the synth root already declares", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerStorage: {
						$className: "ServerStorage",
						$properties: { Name: "kept" },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const serverStorage = child(parseFixture(result).tree, "ServerStorage")!;

		// The stage lives on ServerStorage, so the hoist has to merge rather than
		// replace the node the synthesizer built.
		expect(serverStorage.$properties).toStrictEqual({ Name: "kept" });
		expect(serverStorage["__pkg_stage"]).toBeDefined();
	});

	it("should recover a node whose $className is not a string", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Broken: { $className: 42 },
					},
				},
			}),
		});

		const result = synthesize({
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
				"ReplicatedStorage",
				"Broken",
			)!.$className,
		).toBe("Folder");
	});

	it("should keep LoadStringEnabled on when a package declares it off", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						$className: "ServerScriptService",
						$properties: { LoadStringEnabled: false },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(child(parseFixture(result).tree, "ServerScriptService")!.$properties).toStrictEqual({
			LoadStringEnabled: true,
		});
	});

	it.for([
		"Players",
		"ReplicatedFirst",
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
		"StarterPlayer",
		"StarterPlayerScripts",
		"Workspace",
	])("should rewrite service class %s to Folder when nested", (serviceClass) => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					[serviceClass]: { $className: serviceClass, $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(parsed.tree, "ServerStorage", "__pkg_stage", "@halcyon/foo", serviceClass)!
				.$className,
		).toBe("Folder");
	});

	it.for([
		["StarterPlayer", "StarterPlayerScripts"],
		["StarterPlayer", "StarterCharacterScripts"],
		["Workspace", "Terrain"],
	] as const)(
		"should rewrite %s.%s to Folder — the engine pins the class to one parent",
		([parent, pinned]) => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						[parent]: {
							$className: parent,
							[pinned]: { $className: pinned, $path: "src" },
						},
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
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

		vol.reset();

		vol.fromJSON({
			// Rojo infers a service from the node name at the DataModel root, so
			// ServerScriptService carries no $className here (Nevermore layout).
			// Once relocated under __pkg_stage it needs an explicit one.
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						Pkg: { $path: "src" },
					},
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
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
				"@halcyon/foo",
				"ServerScriptService",
			)!.$className,
		).toBe("Folder");
	});

	it("should not add $className to an implicit service node that already carries a $path", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			// A bare service node with $path and no $className: Rojo mounts the
			// path, so the synthesizer must not override it with a Folder class.
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: { $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
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
				"@halcyon/foo",
				"ServerScriptService",
			)!.$className,
		).toBeUndefined();
	});

	it("should isolate per-package service roots even when packages claim the same service", () => {
		expect.assertions(2);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[path.join(ROOT, "packages/bar/src/init.luau")]: "",
		});

		const result = synthesize({
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
		).toBe(normalizeWindowsPath(path.join(ROOT, "packages/bar/src")));
		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/foo",
				"ReplicatedStorage",
			)!.$path,
		).toBe(normalizeWindowsPath(path.join(FOO_DIR, "src")));
	});

	it("should inject jest.config child at dataModelPath leaf for stubMounts", () => {
		expect.assertions(1);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Common: { $path: "src" },
					},
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Common" },
					],
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/foo",
				"ReplicatedStorage",
				"Common",
				"jest.config",
			)!.$path,
		).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should inject multiple stubMounts on a single package", () => {
		expect.assertions(2);

		vol.reset();

		const stubA = path.join(ROOT, ".cache/foo/a/jest.config.luau");
		const stubB = path.join(ROOT, ".cache/foo/b/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						A: { $path: "src/a" },
						B: { $path: "src/b" },
					},
				},
			}),
			[path.join(FOO_DIR, "src/a/init.luau")]: "",
			[path.join(FOO_DIR, "src/b/init.luau")]: "",
			[stubA]: "return {}",
			[stubB]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubA, dataModelPath: "ReplicatedStorage/A" },
						{ absStubPath: stubB, dataModelPath: "ReplicatedStorage/B" },
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const fooPackage = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
		);

		expect(descend(fooPackage, "A", "jest.config")!.$path).toBe(stubA.replaceAll("\\", "/"));
		expect(descend(fooPackage, "B", "jest.config")!.$path).toBe(stubB.replaceAll("\\", "/"));
	});

	it("should keep stubMounts isolated per package", () => {
		expect.assertions(2);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		const barDirectory = path.join(ROOT, "packages/bar");
		const stubFoo = path.join(ROOT, ".cache/foo/jest.config.luau");
		const stubBar = path.join(ROOT, ".cache/bar/jest.config.luau");
		vol.fromJSON({
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
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						FooMount: { $path: "src" },
					},
				},
			}),
			[path.join(barDirectory, "src/init.luau")]: "",
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[stubBar]: "return {}",
			[stubFoo]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: barDirectory,
					rojoProjectPath: barProject,
					stubMounts: [
						{ absStubPath: stubBar, dataModelPath: "ReplicatedStorage/BarMount" },
					],
				},
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubFoo, dataModelPath: "ReplicatedStorage/FooMount" },
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

	it.for(["jest.config.lua", "jest.config.luau"])(
		"should throw ConfigError when stubMount leaf source dir contains %s",
		(collidingFile) => {
			expect.assertions(2);

			vol.reset();

			const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
			const sourceDirectory = path.join(FOO_DIR, "src");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Common: { $path: "src" },
						},
					},
				}),
				[path.join(sourceDirectory, "init.luau")]: "",
				[path.join(sourceDirectory, collidingFile)]: "return {}",
				[stubPath]: "return {}",
			});

			function callSynthesize(): string {
				return synthesize({
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [
								{
									absStubPath: stubPath,
									dataModelPath: "ReplicatedStorage/Common",
								},
							],
						},
					],
				});
			}

			expect(callSynthesize).toThrow(ConfigError);
			expect(callSynthesize).toThrow(
				path.join(sourceDirectory, collidingFile).replaceAll("\\", "/"),
			);
		},
	);

	it("should not throw when leaf source dir contains unrelated files", () => {
		expect.assertions(1);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		const sourceDirectory = path.join(FOO_DIR, "src");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Common: { $path: "src" },
					},
				},
			}),
			[path.join(sourceDirectory, "config.lua")]: "",
			[path.join(sourceDirectory, "init.luau")]: "",
			[stubPath]: "return {}",
		});

		expect(() => {
			return synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Common" },
						],
					},
				],
			});
		}).not.toThrow();
	});

	it("should throw ConfigError when stubMount dataModelPath does not resolve in the tree", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		expect(() => {
			synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: "/cache/stub.lua",
								dataModelPath: "ReplicatedStorage/Missing",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should skip collision check when stubMount leaf has no $path", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Branch: { $className: "Folder", Leaf: { $path: "src" } },
					},
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: "/cache/stub.lua",
							dataModelPath: "ReplicatedStorage/Branch",
						},
					],
				},
			],
		});

		expect(result).toContain('"jest.config"');
	});

	it("should virtualize a $path-mounted parent to reach a stubMount child on disk", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						"$className": "ReplicatedStorage",
						"foo:tests": { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubPath,
							dataModelPath: "ReplicatedStorage/foo:tests/src",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const fooTests = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"foo:tests",
		);

		expect(descend(fooTests, "src")!.$path).toBe(
			normalizeWindowsPath(path.join(FOO_DIR, "out-test/src")),
		);
		expect(descend(fooTests, "src", "jest.config")!.$path).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should demote $path-mounted parent so rojo does not auto-mount duplicate siblings", () => {
		expect.assertions(4);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						"$className": "ReplicatedStorage",
						"foo:tests": { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/test/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/foo:tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const fooTests = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"foo:tests",
		);

		// Parent must not retain `$path` — rojo would auto-mount a duplicate
		// `src`/`test` sibling alongside the explicit overlay.
		expect(fooTests!.$path).toBeUndefined();
		expect(fooTests!.$className).toBe("Folder");
		// Every on-disk sibling at the parent's $path becomes an explicit child
		// so rojo's auto-mount behaviour is preserved despite the $path
		// removal.
		expect(descend(fooTests, "test")!.$path).toBe(
			normalizeWindowsPath(path.join(FOO_DIR, "out-test/test")),
		);
		expect(descend(fooTests, "src", "jest.config")!.$path).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should skip non-directory siblings during demotion", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/loose.luau")]: "return {}",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const tests = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"Tests",
		);

		// Loose file siblings (which rojo cannot $path-mount as Instances of
		// arbitrary class) are not promoted to explicit children during
		// demotion.
		expect(tests!["loose.luau"]).toBeUndefined();
		expect(tests!["src"]).toBeDefined();
	});

	it("should preserve existing explicit children during demotion", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: {
							$path: "out-test",
							keep: { $path: "../other/extra" },
						},
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/keep/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(ROOT, "packages/other/extra/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const tests = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"Tests",
		);

		// Explicit `keep` already pointed at `../other/extra` — demotion must
		// not overwrite it with the same-named on-disk `out-test/keep`
		// directory.
		expect(descend(tests, "keep")!.$path).toBe(
			normalizeWindowsPath(path.join(ROOT, "packages/other/extra")),
		);
		expect(descend(tests, "keep")!.$path).not.toContain("out-test/keep");
	});

	it("should throw ConfigError when virtualization target segment starts with $", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/$weird/init.luau")]: "",
		});

		expect(() => {
			synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: "/cache/stub.lua",
								dataModelPath: "ReplicatedStorage/Tests/$weird",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should skip dollar-prefixed disk siblings during demotion", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/$weird/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result);

		const tests = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"Tests",
		);

		// `$`-prefixed names collide with rojo's reserved project.json keys
		// (`$path`, `$className`, …) so they must not be added as explicit
		// children even when present on disk.
		expect(tests!["$weird"]).toBeUndefined();
		expect(tests!["src"]).toBeDefined();
	});

	it("should virtualize multiple consecutive $path-mounted segments", () => {
		expect.assertions(1);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/foo/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubPath,
							dataModelPath: "ReplicatedStorage/Tests/src/foo",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result);

		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/foo",
				"ReplicatedStorage",
				"Tests",
				"src",
				"foo",
				"jest.config",
			)!.$path,
		).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should throw ConfigError when virtualization parent has no $path", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Branch: { $className: "Folder" },
					},
				},
			}),
		});

		expect(() => {
			synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: "/cache/stub.lua",
								dataModelPath: "ReplicatedStorage/Branch/Missing",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should throw ConfigError when virtualization target segment resolves to a file", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/leaf.luau")]: "",
		});

		expect(() => {
			synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: "/cache/stub.lua",
								dataModelPath: "ReplicatedStorage/Tests/leaf.luau",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should throw ConfigError when virtualization target segment is missing on disk", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/init.luau")]: "",
		});

		expect(() => {
			synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: "/cache/stub.lua",
								dataModelPath: "ReplicatedStorage/Tests/missing",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should propagate coverage shadow dir through a virtualized $path child", () => {
		expect.assertions(2);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out-test"),
		);
		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(shadowOut, "src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out-test", shadowDir: shadowOut }],
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

		const tests = descend(
			parsed.tree,
			"ServerStorage",
			"__pkg_stage",
			"@halcyon/foo",
			"ReplicatedStorage",
			"Tests",
		);

		// Parent demoted (no $path) so rojo doesn't auto-mount a duplicate `src`
		// alongside the explicit overlay; the shadowed prefix is carried on the
		// explicit child instead.
		expect(tests!.$path).toBeUndefined();
		expect(descend(tests, "src")!.$path).toBe(`${shadowOut}/src`);
	});

	it.for(["jest.config.lua", "jest.config.luau"])(
		"should throw ConfigError when virtualized leaf source dir contains %s",
		(collidingFile) => {
			expect.assertions(2);

			vol.reset();

			const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
			const sourceDirectory = path.join(FOO_DIR, "out-test/src");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Tests: { $path: "out-test" },
						},
					},
				}),
				[path.join(sourceDirectory, "init.luau")]: "",
				[path.join(sourceDirectory, collidingFile)]: "return {}",
				[stubPath]: "return {}",
			});

			function callSynthesize(): string {
				return synthesize({
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

			expect(callSynthesize).toThrow(ConfigError);
			expect(callSynthesize).toThrow(
				path.join(sourceDirectory, collidingFile).replaceAll("\\", "/"),
			);
		},
	);

	it("should produce identical output to a stubMounts-less descriptor when stubMounts is an empty array", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const baseline = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});
		const withEmpty = synthesize({
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

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
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
				"@halcyon/foo",
				"ReplicatedStorage",
				"Pkg",
			)!.$path,
		).toBe(shadowOut);
	});

	it("should leave $path untouched for packages that opt out of coverageRoots", () => {
		expect.assertions(2);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		const fooShadow = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
			[path.join(ROOT, "packages/bar/out/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: path.join(ROOT, "packages/bar"),
					rojoProjectPath: barProject,
				},
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: fooShadow }],
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
		).toBe(normalizeWindowsPath(path.join(ROOT, "packages/bar/out")));
		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/foo",
				"ReplicatedStorage",
				"Pkg",
			)!.$path,
		).toBe(fooShadow);
	});

	it("should pass nested $path entries through the coverage shadow dir prefix", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/client" } },
				},
			}),
			[path.join(FOO_DIR, "out/client/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
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
				"@halcyon/foo",
				"ReplicatedStorage",
				"Client",
			)!.$path,
		).toBe(`${shadowOut}/client`);
	});

	it("should normalize trailing slashes on $path before matching coverageRoots", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out/" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result);

		// Must NOT have a trailing slash → not "<shadowOut>/".
		expect(
			descend(
				parsed.tree,
				"ServerStorage",
				"__pkg_stage",
				"@halcyon/foo",
				"ReplicatedStorage",
				"Pkg",
			)!.$path,
		).toBe(shadowOut);
	});

	it("should leave $path entries that don't match any coverageRoot using package-relative resolution", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Other: { $path: "vendor" } },
				},
			}),
			[path.join(FOO_DIR, "vendor/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
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
				"@halcyon/foo",
				"ReplicatedStorage",
				"Other",
			)!.$path,
		).toBe(normalizeWindowsPath(path.join(FOO_DIR, "vendor")));
	});

	it("should be byte-stable regardless of input package ordering", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: { $className: "DataModel" },
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});

		const ordered = synthesize({
			packages: [
				{ name: "@halcyon/bar", packageDirectory: ROOT, rojoProjectPath: barProject },
				{ name: "@halcyon/foo", packageDirectory: ROOT, rojoProjectPath: FOO_PROJECT },
			],
		});
		const reversed = synthesize({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: ROOT, rojoProjectPath: FOO_PROJECT },
				{ name: "@halcyon/bar", packageDirectory: ROOT, rojoProjectPath: barProject },
			],
		});

		expect(ordered).toBe(reversed);
	});

	describe("no-wrap mode (single-package coverage)", () => {
		it("should return the package's project tree without ServerStorage.__pkg_stage wrap", () => {
			expect.assertions(2);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$className).toBe("ReplicatedStorage");
			expect(descend(parsed.tree, "ServerStorage", "__pkg_stage")).toBeUndefined();
		});

		it("should inject ServerScriptService.LoadStringEnabled when loadStringEnabled is set", () => {
			expect.assertions(2);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				loadStringEnabled: true,
				packages: [
					{
						name: "@halcyon/foo",
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

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ServerScriptService: {
							$className: "ServerScriptService",
							$path: "server",
							$properties: { OtherProp: "kept" },
						},
					},
				}),
				[path.join(FOO_DIR, "server/init.luau")]: "",
			});

			const result = synthesize({
				loadStringEnabled: true,
				packages: [
					{
						name: "@halcyon/foo",
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

		it("should tolerate a malformed null $properties on ServerScriptService", () => {
			// `typeof null === "object"`, so an unguarded property check would
			// treat null as a record and `Object.entries(null)` would throw.
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ServerScriptService: {
							$className: "ServerScriptService",
							$path: "server",
							$properties: null,
						},
					},
				}),
				[path.join(FOO_DIR, "server/init.luau")]: "",
			});

			const result = synthesize({
				loadStringEnabled: true,
				packages: [
					{
						name: "@halcyon/foo",
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

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(parsed.tree["ServerScriptService"]).toBeUndefined();
		});

		it("should preserve all top-level project fields (gameId, placeId, globIgnorePaths, servePort, name)", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					gameId: 99,
					globIgnorePaths: ["**/foo.txt"],
					placeId: 100,
					servePort: 12345,
					tree: { $className: "DataModel" },
				}),
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

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

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$path).toBe(
				normalizeWindowsPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should redirect $path entries under coverageRoots[].luauRoot to the shadow directory", () => {
			expect.assertions(1);

			vol.reset();

			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/src");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [{ luauRoot: "src", shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$path).toBe(
				normalizeWindowsPath(shadowDirectory),
			);
		});

		it("should redirect coverageRoots[].luauRoot resolved against packageDirectory when rojoProject sits in a subdirectory", () => {
			expect.assertions(1);

			vol.reset();

			const subProject = path.join(FOO_DIR, "config/dev.project.json");
			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/out");
			vol.fromJSON({
				[path.join(FOO_DIR, "out/init.luau")]: "",
				[subProject]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "../out" },
					},
				}),
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [{ luauRoot: "out", shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: subProject,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(child(parsed.tree, "ReplicatedStorage")!.$path).toBe(
				normalizeWindowsPath(shadowDirectory),
			);
		});
	});

	describe("wrap mode (workspace) dual-base resolution", () => {
		it("should redirect coverageRoots[].luauRoot resolved against packageDirectory when rojoProject sits in a subdirectory", () => {
			expect.assertions(1);

			vol.reset();

			const subProject = path.join(FOO_DIR, "config/dev.project.json");
			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/out");
			vol.fromJSON({
				[path.join(FOO_DIR, "out/init.luau")]: "",
				[subProject]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "../out" },
					},
				}),
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [{ luauRoot: "out", shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: subProject,
					},
				],
			});

			const parsed = parseFixture(result);

			expect(
				descend(
					parsed.tree,
					"ServerStorage",
					"__pkg_stage",
					"@halcyon/foo",
					"ReplicatedStorage",
				)!.$path,
			).toBe(normalizeWindowsPath(shadowDirectory));
		});
	});

	describe("no-wrap mode validation", () => {
		it("should throw ConfigError when wrap=false with zero packages", () => {
			expect.assertions(1);

			expect(() => synthesize({ packages: [], wrap: false })).toThrow(ConfigError);
		});

		it("should resolve nested .project.json mounts in no-wrap mode", () => {
			expect.assertions(1);

			vol.reset();

			const nestedProject = path.join(FOO_DIR, "nested.project.json");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Common: { $path: "nested.project.json" },
						},
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

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result);

			expect(descend(parsed.tree, "ReplicatedStorage", "Common", "Sub")!.$path).toBe(
				normalizeWindowsPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should throw ConfigError when wrap=false with more than one package", () => {
			expect.assertions(1);

			vol.reset();

			const barProject = path.join(ROOT, "packages/bar/test.project.json");
			vol.fromJSON({
				[barProject]: projectJson({
					name: "bar-test",
					tree: { $className: "DataModel" },
				}),
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: { $className: "DataModel" },
				}),
			});

			expect(() => {
				return synthesize({
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
						},
						{
							name: "@halcyon/bar",
							packageDirectory: path.join(ROOT, "packages/bar"),
							rojoProjectPath: barProject,
						},
					],
					wrap: false,
				});
			}).toThrow(ConfigError);
		});

		// Multi-project + open-cloud wire shape: synthesizer must produce a
		// place-buildable project.json from a single user package with
		// multiple project mounts and stubs in the cache.
		it("should produce a place-ready synthesized project for multi-project + open-cloud shape", () => {
			expect.assertions(5);

			vol.reset();

			vol.fromJSON({
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
				packages: [
					{
						name: "@user/game",
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
			expect(parsed).toMatchObject({ name: "user-game", gameId: 4242, placeId: 9999 });

			// Both project mounts retained with stubs injected as named children.
			expect(descend(parsed.tree, "ReplicatedStorage", "Shared")!.$path).toContain("out");
			expect(
				descend(parsed.tree, "ReplicatedStorage", "Shared", "jest.config")!.$path,
			).toContain("shared");
			expect(descend(parsed.tree, "ServerStorage", "Server")!.$path).toContain("out");
			expect(descend(parsed.tree, "ServerStorage", "Server", "jest.config")!.$path).toContain(
				"server",
			);
		});

		// Structural collision: the synthesizer must refuse to overwrite a
		// `jest.config` named-child already declared in the user's
		// `.project.json` tree (e.g. mounted from elsewhere via `$path`),
		// not just files-on-disk under the leaf's `$path`.
		it("should error when user's project tree already declares a jest.config named child at the leaf", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							"$className": "ReplicatedStorage",
							"$path": "src",
							"jest.config": { $path: "configs/custom-jest.luau" },
						},
					},
				}),
				[path.join(FOO_DIR, ".jest-roblox/jest.config.luau")]: "-- stub",
				[path.join(FOO_DIR, "configs/custom-jest.luau")]: "return {}",
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			expect(() => {
				return synthesize({
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [
								{
									absStubPath: path.join(
										FOO_DIR,
										".jest-roblox/jest.config.luau",
									),
									dataModelPath: "ReplicatedStorage",
								},
							],
						},
					],
					wrap: false,
				});
			}).toThrow(/would overwrite an existing/);
		});

		// Preservation contract: arbitrary unknown top-level keys (future
		// Rojo schema additions, user custom fields) must survive
		// `synthesize(wrap: false)` byte-for-byte, including when
		// `injectStubMounts` mutates the tree.
		it("should preserve arbitrary unknown top-level keys and nested unknown fields through stub injection", () => {
			expect.assertions(4);

			vol.reset();

			vol.fromJSON({
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
				packages: [
					{
						name: "@halcyon/foo",
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
