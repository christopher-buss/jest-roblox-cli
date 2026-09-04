import { scope } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createCopyIgnoreMatcher } from "../src/coverage-pipeline/discover-files.ts";
import { prepareSpine, resolveSpineDirectories } from "../src/coverage-pipeline/spine.ts";
import { buildPlaceAsync } from "../src/staging/place-builder.ts";
import type { PackageDescriptor } from "../src/staging/synthesizer.ts";
import { synthesize } from "../src/staging/synthesizer.ts";
import type { RojoTreeNode } from "../src/types/rojo.ts";
import { normalizeWindowsPath, toPosixRoot } from "../src/utils/normalize-windows-path.ts";
import { buildWithRojoAsync } from "../src/utils/rojo-builder.ts";

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

function createTemporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synth-rojo-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

// A scope rather than a bare `type`, because the node refers to itself and
// only an alias can carry that.
const sourcemapNodeSchema = scope({
	sourcemapNode: {
		"name": "string",
		"children?": "sourcemapNode[]",
		"filePaths?": "string[]",
	},
}).export().sourcemapNode;

type SourcemapNode = typeof sourcemapNodeSchema.infer;

/**
 * What rojo would build, read without building it. `sourcemap` names every
 * Instance the project resolves to, and `--include-non-scripts` is what makes
 * the Folders a duplicate mount shows up as visible.
 */
function readSourcemap(projectPath: string): SourcemapNode {
	// `--absolute` because the synthesized project sits in `.jest-roblox` while
	// its `$path`s point back at the packages, and rojo cannot express one
	// relative to the other.
	const output = cp.execFileSync(
		"rojo",
		["sourcemap", projectPath, "--absolute", "--include-non-scripts"],
		{ encoding: "utf-8", windowsHide: true },
	);
	return sourcemapNodeSchema.assert(JSON.parse(output));
}

/** Every Instance in the tree the predicate accepts, however deep. */
function collectNodes(
	node: SourcemapNode,
	accepts: (candidate: SourcemapNode) => boolean,
): Array<SourcemapNode> {
	const found = accepts(node) ? [node] : [];
	const children = node.children ?? [];
	for (const child of children) {
		found.push(...collectNodes(child, accepts));
	}

	return found;
}

/** Every Instance in the tree carrying `name`, however deep. */
function namedNodes(node: SourcemapNode, name: string): Array<SourcemapNode> {
	return collectNodes(node, (candidate) => candidate.name === name);
}

/**
 * The spelling two paths share when they name the same file.
 *
 * `rojo sourcemap --absolute` writes each path through Rust's
 * `std::path::absolute`, which collapses `..` on Windows and leaves it in
 * place on posix. The synthesized project reaches its mounts through `../../`,
 * so a posix sourcemap path carries that segment and a Windows one does not.
 * `path.posix.normalize` collapses it on either host, and asks nothing about
 * what counts as absolute there.
 */
function samePath(filePath: string): string {
	return path.posix.normalize(normalizeWindowsPath(filePath));
}

/**
 * Every Instance rojo would build from a path on disk. Counting these is what
 * says a mount was built once: a marker names the pooled entry rather than the
 * path, so it reads as an Instance with no file behind it.
 */
function nodesBuiltFrom(node: SourcemapNode, filePath: string): Array<SourcemapNode> {
	const target = samePath(filePath);
	return collectNodes(node, (candidate) => {
		return (candidate.filePaths ?? []).some((each) => samePath(each) === target);
	});
}

/**
 * The Instance at a path of names below `node`, or `undefined` when the walk
 * runs out. The absolute path compiled test output writes is a walk like this
 * one, so a stage that answers it is a stage whose requires resolve.
 */
function descend(node: SourcemapNode, ...names: Array<string>): SourcemapNode | undefined {
	return names.reduce<SourcemapNode | undefined>(
		(current, name) => (current?.children ?? []).find((child) => child.name === name),
		node,
	);
}

function childNames(node: SourcemapNode): Array<string> {
	const children = node.children ?? [];
	return children.map((child) => child.name);
}

/**
 * What one package mounts beside its own sources, nested the way a real
 * project mounts its dependencies: `rbxts_include.node_modules.<scope>` sits
 * two levels under the service, so the pool has to reach below the top.
 */
const VENDOR_SHARED: RojoTreeNode = { Vendor: { Shared: { $path: "../../shared" } } };
/**
 * The `rbxts_include` shape: the shared include tree mounted with the
 * generated `node_modules` project declared beside it as an explicit child.
 * What every roblox-ts package's test project mounts.
 */
const RBXTS_INCLUDE: RojoTreeNode = {
	rbxts_include: {
		$path: "../../include",
		// The loader folds this in before the pool sees it, so what pools is
		// each leaf the generated project mounts.
		node_modules: { $path: "../../vendor/node_modules.project.json" },
	},
};

/** One generated stub, mounted from every package in a workspace run. */
const SHARED_STUB: RojoTreeNode = { Config: { $path: "../../jest.config.luau" } };

/**
 * A package whose test project mounts its own `src` plus whatever `shared`
 * declares under `ReplicatedStorage` — the shape every package in a real
 * workspace has, differing only in what it mounts beside its sources.
 */
function writePackage({
	name,
	shared,
	workspace,
}: {
	name: string;
	/** What the package mounts beside its own sources. */
	shared: RojoTreeNode;
	workspace: string;
}): PackageDescriptor {
	const packageDirectory = path.join(workspace, "packages", name);
	fs.mkdirSync(path.join(packageDirectory, "src"), { recursive: true });
	fs.writeFileSync(path.join(packageDirectory, "src", `${name}.luau`), "return {}\n");
	fs.writeFileSync(
		path.join(packageDirectory, "test.project.json"),
		JSON.stringify({
			name: `${name}-test`,
			tree: {
				$className: "DataModel",
				ReplicatedStorage: {
					...shared,
					$className: "ReplicatedStorage",
					Src: { $path: "src" },
				},
			},
		}),
	);

	return {
		name: `@halcyon/${name}`,
		packageDirectory,
		rojoProjectPath: path.join(packageDirectory, "test.project.json"),
	};
}

/** The packages the generated `node_modules` project mounts, one each. */
const NODE_MODULES_LEAVES = ["services", "t"];

/** The include tree and the generated `node_modules` project beside it. */
function writeSharedDependencies(workspace: string): void {
	const include = path.join(workspace, "include");
	fs.mkdirSync(include, { recursive: true });
	fs.writeFileSync(path.join(include, "runtime.luau"), "return {}\n");

	// `init.luau` directories, which rojo mounts as ModuleScripts rather than
	// Folders — the shape every `@rbxts/*` package has. Two of them, because
	// the pool gives each leaf an entry of its own.
	for (const leaf of NODE_MODULES_LEAVES) {
		const directory = path.join(workspace, "vendor/packages", leaf);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "init.luau"), "return {}\n");
		fs.writeFileSync(path.join(directory, `${leaf}Helper.luau`), "return {}\n");
	}

	fs.writeFileSync(
		path.join(workspace, "vendor/node_modules.project.json"),
		JSON.stringify({
			name: "node_modules",
			tree: {
				"$className": "Folder",
				"@rbxts": {
					$className: "Folder",
					...Object.fromEntries(
						NODE_MODULES_LEAVES.map((leaf) => [leaf, { $path: `packages/${leaf}` }]),
					),
				},
			},
		}),
	);
}

describe("synthesizer + rojo build integration", () => {
	it.skipIf(!rojoOnPath())(
		"should build a directory two packages mount into the place once",
		async () => {
			expect.assertions(4);

			const workspace = createTemporaryDirectory();
			const shared = path.join(workspace, "shared");
			fs.mkdirSync(shared, { recursive: true });
			fs.writeFileSync(path.join(shared, "sharedModule.luau"), "return {}\n");

			const synthDirectory = path.join(workspace, ".jest-roblox/workspace");
			const synthProjectPath = path.join(synthDirectory, "synthesized.project.json");
			await buildPlaceAsync({
				packages: [
					writePackage({ name: "foo", shared: VENDOR_SHARED, workspace }),
					writePackage({ name: "bar", shared: VENDOR_SHARED, workspace }),
				],
				placeFile: path.join(synthDirectory, "synthesized.rbxl"),
				projectFile: synthProjectPath,
			});

			const root = readSourcemap(synthProjectPath);
			const pool = namedNodes(root, "__shared");

			// One copy of the shared directory in the whole place, under the
			// pool, and a marker in each package where the copy used to be.
			expect(namedNodes(root, "sharedModule")).toHaveLength(1);
			expect(pool).toHaveLength(1);
			expect(childNames(pool[0]!)).toHaveLength(1);
			expect(namedNodes(root, "Shared").map((node) => childNames(node))).toStrictEqual([
				[],
				[],
			]);
		},
	);

	it.skipIf(!rojoOnPath())(
		"should build one copy of a shared include tree that keeps its own children",
		async () => {
			expect.assertions(5);

			const workspace = createTemporaryDirectory();
			writeSharedDependencies(workspace);

			const synthDirectory = path.join(workspace, ".jest-roblox/workspace");
			const synthProjectPath = path.join(synthDirectory, "synthesized.project.json");
			await buildPlaceAsync({
				packages: [
					writePackage({ name: "foo", shared: RBXTS_INCLUDE, workspace }),
					writePackage({ name: "bar", shared: RBXTS_INCLUDE, workspace }),
				],
				placeFile: path.join(synthDirectory, "synthesized.rbxl"),
				projectFile: synthProjectPath,
			});

			const root = readSourcemap(synthProjectPath);

			// The mount pools even though the node declares a child beside it,
			// and the `init.luau` leaf the inlined project mounts pools with it.
			expect(nodesBuiltFrom(root, path.join(workspace, "include/runtime.luau"))).toHaveLength(
				1,
			);
			expect(
				NODE_MODULES_LEAVES.flatMap((leaf) => {
					return nodesBuiltFrom(
						root,
						path.join(workspace, `vendor/packages/${leaf}/${leaf}Helper.luau`),
					);
				}),
			).toHaveLength(NODE_MODULES_LEAVES.length);
			// The child stays where the package wrote it, under the marker.
			expect(namedNodes(root, "rbxts_include").map((node) => childNames(node))).toStrictEqual(
				[["node_modules"], ["node_modules"]],
			);
			// And each stage still answers the absolute path compiled output
			// writes, down to every leaf.
			expect(
				namedNodes(root, "rbxts_include").map((stage) => {
					return NODE_MODULES_LEAVES.map(
						(leaf) => descend(stage, "node_modules", "@rbxts", leaf)!.name,
					);
				}),
			).toStrictEqual([NODE_MODULES_LEAVES, NODE_MODULES_LEAVES]);
			expect(namedNodes(root, "__shared")).toHaveLength(1);
		},
	);

	it.skipIf(!rojoOnPath())(
		"should build a single file two packages mount into the place once",
		async () => {
			expect.assertions(3);

			const workspace = createTemporaryDirectory();
			const stub = path.join(workspace, "jest.config.luau");
			fs.writeFileSync(stub, "return {}\n");

			const synthDirectory = path.join(workspace, ".jest-roblox/workspace");
			const synthProjectPath = path.join(synthDirectory, "synthesized.project.json");
			await buildPlaceAsync({
				packages: [
					writePackage({ name: "foo", shared: SHARED_STUB, workspace }),
					writePackage({ name: "bar", shared: SHARED_STUB, workspace }),
				],
				placeFile: path.join(synthDirectory, "synthesized.rbxl"),
				projectFile: synthProjectPath,
			});

			const root = readSourcemap(synthProjectPath);
			const [pool] = namedNodes(root, "__shared");

			// One rule for a mount, whether it names a directory or a file: one
			// copy under the pool, and a marker in each package naming it.
			expect(nodesBuiltFrom(root, stub)).toHaveLength(1);
			expect(nodesBuiltFrom(pool!, stub)).toHaveLength(1);
			expect(namedNodes(root, "Config").map((node) => childNames(node))).toStrictEqual([
				[],
				[],
			]);
		},
	);

	it.skipIf(!rojoOnPath())(
		"should produce a project.json that rojo can build into a valid rbxl",
		async () => {
			expect.assertions(2);

			const workspace = createTemporaryDirectory();
			const packageDirectory = path.join(workspace, "packages/foo");
			fs.mkdirSync(path.join(packageDirectory, "src"), { recursive: true });
			fs.writeFileSync(path.join(packageDirectory, "src", "example.luau"), "return {}\n");
			fs.writeFileSync(
				path.join(packageDirectory, "test.project.json"),
				JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
			);

			const synthesized = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory,
						rojoProjectPath: path.join(packageDirectory, "test.project.json"),
					},
				],
			});

			const synthDirectory = path.join(workspace, ".jest-roblox/workspace");
			fs.mkdirSync(synthDirectory, { recursive: true });
			const synthProjectPath = path.join(synthDirectory, "synthesized.project.json");
			const synthRbxlPath = path.join(synthDirectory, "synthesized.rbxl");
			fs.writeFileSync(synthProjectPath, synthesized);

			await buildWithRojoAsync(synthProjectPath, synthRbxlPath);

			expect(fs.existsSync(synthRbxlPath)).toBeTrue();
			expect(fs.statSync(synthRbxlPath).size).toBeGreaterThan(0);
		},
	);

	it.skipIf(!rojoOnPath())(
		"should build one Instance per directory when a coverage spine nests",
		() => {
			expect.assertions(4);

			const workspace = createTemporaryDirectory();
			const packageDirectory = path.join(workspace, "packages/foo");
			function write(relativePath: string, contents: string): void {
				const absolute = path.join(packageDirectory, relativePath);
				fs.mkdirSync(path.dirname(absolute), { recursive: true });
				fs.writeFileSync(absolute, contents);
			}

			// One covered root, three levels below the mount, with a loose file
			// and an uncovered sibling at each level on the way down.
			write("out/loose.luau", "return {}\n");
			write("out/shared/log-config.luau", "return {}\n");
			write("out/shared/modules/net.luau", "return {}\n");
			write("out/shared/modules/utilities/helper.luau", "return {}\n");
			write("out/shared/modules/ecs/world.luau", "return {}\n");
			write(
				"test.project.json",
				JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "out" },
					},
				}),
			);

			const shadowRoot = normalizeWindowsPath(path.join(workspace, ".jest-roblox/coverage"));
			const shadowDirectory = `${shadowRoot}/out/shared/modules/ecs`;
			fs.mkdirSync(shadowDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(shadowDirectory, "world.luau"),
				"-- instrumented\nreturn {}\n",
			);

			// The layout under test: the real spine pass decides where each
			// demoted level's own files land, and synthesis mounts exactly what
			// it names.
			const spine = prepareSpine({
				isCopyIgnored: createCopyIgnoreMatcher([]),
				narrowed: [
					{
						luauRoot: toPosixRoot("out"),
						roots: [toPosixRoot("out/shared/modules/ecs")],
						spine: resolveSpineDirectories(
							[toPosixRoot("out/shared/modules/ecs")],
							new Set(["out"]),
						),
					},
				],
				previousNonInstrumented: undefined,
				shadowRoot,
				toSourcePath: (relativePath) => {
					return normalizeWindowsPath(path.join(packageDirectory, relativePath));
				},
			});

			const synthesized = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [
							{
								luauRoot: toPosixRoot("out/shared/modules/ecs"),
								shadowDir: shadowDirectory,
							},
						],
						coverageSpine: spine.directories,
						packageDirectory,
						rojoProjectPath: path.join(packageDirectory, "test.project.json"),
					},
				],
			});

			const synthDirectory = path.join(workspace, ".jest-roblox/workspace");
			fs.mkdirSync(synthDirectory, { recursive: true });
			const synthProjectPath = path.join(synthDirectory, "synthesized.project.json");
			fs.writeFileSync(synthProjectPath, synthesized);

			const root = readSourcemap(synthProjectPath);

			// A spine level whose mount still contained the level below it would
			// build that level twice — once auto-mounted through the `$path`,
			// once as the explicit child the demote hangs beside it — and
			// whichever copy a require resolved first decided what it could see.
			expect(namedNodes(root, "modules")).toHaveLength(1);
			expect(childNames(namedNodes(root, "modules")[0]!)).toIncludeSameMembers([
				"ecs",
				"net",
				"utilities",
			]);
			expect(namedNodes(root, "shared")).toHaveLength(1);
			expect(childNames(namedNodes(root, "shared")[0]!)).toIncludeSameMembers([
				"log-config",
				"modules",
			]);
		},
	);
});
