import { fromAny } from "@total-typescript/shoehorn";

import { type, type Type } from "arktype";
import { vol } from "memfs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { poolSharedMounts } from "./shared-pool.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const PROJECT_DIR = path.resolve("/repo/cache");
const INCLUDE = path.resolve("/repo/include");
const SHADOW = path.resolve("/repo/cache/coverage");

// Rojo tree nodes are keyed by arbitrary instance names dictated by the
// fixture's project.json, so they are read through one owned schema rather
// than an ad-hoc cast per test.
const rojoTreeNodeSchema: Type<RojoTreeNode> = type({
	"[string]": "unknown",
}).as<RojoTreeNode>();

const pooledProjectSchema = type({ "[string]": "unknown", "tree": "object" });

function seed(files: Record<string, string> = {}): void {
	vol.reset();
	vol.fromJSON(files);
}

function stagedProject(stage: RojoTreeNode): string {
	return JSON.stringify({
		name: "jest-roblox-workspace",
		tree: {
			$className: "DataModel",
			ServerStorage: { $className: "ServerStorage", __pkg_stage: stage },
		},
	});
}

function run(projectJson: string): string {
	return poolSharedMounts({ projectDirectory: PROJECT_DIR, projectJson });
}

function pooledProject(projectJson: string): typeof pooledProjectSchema.infer {
	return pooledProjectSchema.assert(JSON.parse(run(projectJson)));
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
	project: typeof pooledProjectSchema.infer,
	...keys: Array<string>
): RojoTreeNode | undefined {
	return ["ServerStorage", "__pkg_stage", ...keys].reduce<RojoTreeNode | undefined>(
		(current, key) => (current === undefined ? undefined : child(current, key)),
		rojoTreeNodeSchema.assert(project.tree),
	);
}

/**
 * The digest the pass is expected to key a pooled path on, derived here from
 * the documented rule — a sha256 over the posix path relative to the project
 * directory — rather than from the pass itself.
 */
function digestOf(absolutePath: string): string {
	return crypto
		.createHash("sha256")
		.update(normalizeWindowsPath(path.relative(PROJECT_DIR, absolutePath)))
		.digest("hex")
		.slice(0, 16);
}

/**
 * The attribute a marker carries, or `undefined` when the node is no marker.
 */
function poolKeyOf(node: RojoTreeNode | undefined): string | undefined {
	const attributes = node?.["$attributes"];
	if (attributes === undefined) {
		return undefined;
	}

	const value = rojoTreeNodeSchema.assert(attributes)["JestSharedPoolKey"];
	return typeof value === "string" ? value : undefined;
}

/** A childless node mounting a directory — the shape the pass pools. */
function folderMount(mountPath: string): RojoTreeNode {
	return { $className: "Folder", $path: mountPath };
}

/**
 * A package under coverage: it shares `include/` with its siblings and runs
 * against its own instrumented copy of its own `out`.
 */
function coveredPackage(name: string): RojoTreeNode {
	return {
		$className: "Folder",
		Include: folderMount(INCLUDE),
		Out: folderMount(path.join(SHADOW, name, "out")),
	};
}

/** Two packages staging the same node under the same name. */
function twoPackagesStaging(node: RojoTreeNode, key = "Include"): string {
	return stagedProject({
		a: { [key]: structuredClone(node), $className: "Folder" },
		b: { [key]: structuredClone(node), $className: "Folder" },
	});
}

describe(poolSharedMounts, () => {
	it("should hoist a directory two packages mount into one pooled entry", () => {
		expect.assertions(4);

		seed({ [path.join(INCLUDE, "runtime.luau")]: "" });

		const project = pooledProject(
			twoPackagesStaging(folderMount(INCLUDE), "ReplicatedStorage"),
		);
		const key = digestOf(INCLUDE);

		expect(staged(project, "__shared", key)!.$path).toBe(normalizeWindowsPath(INCLUDE));
		expect(poolKeyOf(staged(project, "a", "ReplicatedStorage"))).toBe(key);
		expect(poolKeyOf(staged(project, "b", "ReplicatedStorage"))).toBe(key);
		// Only the pooled entry still names the path; each marker lost its own.
		expect(staged(project, "a", "ReplicatedStorage")!.$path).toBeUndefined();
	});

	it("should declare a class on both halves of what it writes", () => {
		expect.assertions(2);

		// The pool holds no mount of its own for rojo to infer a class from,
		// and the marker has to stand where a Folder stood.
		seed({ [path.join(INCLUDE, "runtime.luau")]: "" });

		const project = pooledProject(twoPackagesStaging(folderMount(INCLUDE)));

		expect(staged(project, "__shared")!.$className).toBe("Folder");
		expect(staged(project, "a", "Include")!.$className).toBe("Folder");
	});

	it("should pool a mount that declares no class of its own", () => {
		expect.assertions(1);

		// What a rojo project usually writes: a bare `{ "$path": ... }`, with
		// the class left to rojo. Only the stage roots synthesis builds carry
		// an explicit Folder.
		seed({ [path.join(INCLUDE, "runtime.luau")]: "" });

		const project = pooledProject(twoPackagesStaging({ $path: INCLUDE }));

		expect(poolKeyOf(staged(project, "a", "Include"))).toBe(digestOf(INCLUDE));
	});

	it("should pool nothing when a package already holds the pool's name", () => {
		expect.assertions(1);

		// A Luau-only package takes its name from its directory basename, so a
		// directory named `__shared` stages under the key the pool wants. Its
		// tree is the run, and the pool is only an optimization, so the pool is
		// what gives way.
		seed({ [path.join(INCLUDE, "runtime.luau")]: "" });
		const projectJson = stagedProject({
			__shared: { $className: "Folder", Include: folderMount(INCLUDE) },
			a: { $className: "Folder", Include: folderMount(INCLUDE) },
			b: { $className: "Folder", Include: folderMount(INCLUDE) },
		});

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should leave a mount only one package references alone", () => {
		expect.assertions(1);

		seed({ [path.join(INCLUDE, "runtime.luau")]: "" });
		const projectJson = stagedProject({
			a: {
				$className: "Folder",
				ReplicatedStorage: { $className: "Folder", $path: INCLUDE },
			},
			b: { $className: "Folder" },
		});

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

	it("should leave each package's own coverage shadow out of the pool", () => {
		expect.assertions(3);

		// What a coverage run stages: both packages share `include/`, and each
		// runs against its own instrumented copy of its own `out`.
		seed({
			[path.join(INCLUDE, "runtime.luau")]: "",
			[path.join(SHADOW, "a/out/main.luau")]: "",
			[path.join(SHADOW, "b/out/main.luau")]: "",
		});
		const project = pooledProject(
			stagedProject({
				a: coveredPackage("a"),
				b: coveredPackage("b"),
			}),
		);

		expect(poolKeyOf(staged(project, "a", "Include"))).toBe(digestOf(INCLUDE));
		// Untouched, so each keeps the exact text synthesis wrote.
		expect(staged(project, "a", "Out")!.$path).toBe(path.join(SHADOW, "a/out"));
		expect(staged(project, "b", "Out")!.$path).toBe(path.join(SHADOW, "b/out"));
	});

	it.for([
		[
			"a mount carrying explicit children of its own",
			{ $className: "Folder", $path: INCLUDE, Extra: { $className: "Folder" } },
		],
		["a mount declaring a class of its own", { $className: "Configuration", $path: INCLUDE }],
		["a mount carrying properties of its own", { $path: INCLUDE, $properties: { Name: "x" } }],
	] as const)("should leave %s alone", ([, node]) => {
		expect.assertions(1);

		seed({ [path.join(INCLUDE, "runtime.luau")]: "" });
		const projectJson = twoPackagesStaging(node);

		expect(run(projectJson)).toBe(projectJson);
	});

	it.for([
		["a directory rojo mounts as a ModuleScript", "include/init.luau"],
		["a directory an init.meta.json classes", "include/init.meta.json"],
	] as const)("should leave %s alone", ([, seeded]) => {
		expect.assertions(1);

		// The plain sibling matters: one entry classing the directory is enough,
		// however many ordinary files sit beside it.
		seed({
			[path.join(INCLUDE, "runtime.luau")]: "",
			[path.join(path.resolve("/repo"), seeded)]: "",
		});
		const projectJson = twoPackagesStaging(folderMount(INCLUDE));

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should leave a mount that is not on disk alone", () => {
		expect.assertions(1);

		// A stub the run has not generated yet, or a project naming a path that
		// moved. Nothing to pool, and nothing to fail the build over either.
		seed();
		const projectJson = twoPackagesStaging(folderMount(path.resolve("/repo/missing")));

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should leave a single file two packages mount alone", () => {
		expect.assertions(1);

		const stub = path.join(path.resolve("/repo"), "jest.config.luau");
		seed({ [stub]: "return {}\n" });
		const projectJson = twoPackagesStaging({ $path: stub }, "Config");

		expect(run(projectJson)).toBe(projectJson);
	});

	it("should give every pooled path an entry of its own", () => {
		expect.assertions(2);

		const assets = path.resolve("/repo/assets");
		seed({
			[path.join(assets, "map.luau")]: "",
			[path.join(INCLUDE, "runtime.luau")]: "",
		});
		const both: RojoTreeNode = {
			$className: "Folder",
			Assets: folderMount(assets),
			Include: folderMount(INCLUDE),
		};

		const project = pooledProject(
			stagedProject({
				a: structuredClone(both),
				b: structuredClone(both),
			}),
		);

		expect(staged(project, "__shared", digestOf(INCLUDE))!.$path).toBe(
			normalizeWindowsPath(INCLUDE),
		);
		expect(staged(project, "__shared", digestOf(assets))!.$path).toBe(
			normalizeWindowsPath(assets),
		);
	});

	it("should key a mount on its path relative to the project directory", () => {
		expect.assertions(1);

		// The same checkout at two roots: the absolute paths differ, the
		// relative ones do not, and place reuse hits only if the key agrees.
		const elsewhere = path.resolve("/elsewhere");
		seed({
			[path.join(elsewhere, "include/runtime.luau")]: "",
			[path.join(INCLUDE, "runtime.luau")]: "",
		});
		const here = pooledProject(twoPackagesStaging(folderMount(INCLUDE)));
		const there = poolSharedMounts({
			projectDirectory: path.join(elsewhere, "cache"),
			projectJson: twoPackagesStaging(folderMount(path.join(elsewhere, "include"))),
		});

		expect(poolKeyOf(staged(here, "a", "Include"))).toBe(
			poolKeyOf(staged(pooledProjectSchema.assert(JSON.parse(there)), "a", "Include")),
		);
	});
});
