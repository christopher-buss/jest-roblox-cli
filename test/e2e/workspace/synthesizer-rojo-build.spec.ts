import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import {
	childNames,
	descend,
	namedNodes,
	nodesBuiltFrom,
	readSourcemap,
} from "#test/e2e/workspace/sourcemap.ts";
import { buildPlaceAsync } from "../../../src/staging/place-builder.ts";
import type { PackageDescriptor } from "../../../src/staging/synthesizer-types.ts";
import type { RojoTreeNode } from "../../../src/types/rojo.ts";

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

/**
 * A package whose test project mounts its own `src` plus whatever `shared`
 * declares under `ReplicatedStorage` — the shape every package in a real
 * workspace has, differing only in what it mounts beside its sources.
 * @param options - Package name, shared mounts and workspace directory.
 * @returns The written package.
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

/**
 * The include tree and the generated `node_modules` project beside it.
 * @param workspace - Workspace directory.
 */
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
});
