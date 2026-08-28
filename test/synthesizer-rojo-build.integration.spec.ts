import { scope } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createCopyIgnoreMatcher } from "../src/coverage-pipeline/discover-files.ts";
import { prepareSpine, resolveSpineDirectories } from "../src/coverage-pipeline/spine.ts";
import { synthesize } from "../src/staging/synthesizer.ts";
import { normalizeWindowsPath } from "../src/utils/normalize-windows-path.ts";
import { buildWithRojo } from "../src/utils/rojo-builder.ts";

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

/** Every Instance in the tree carrying `name`, however deep. */
function namedNodes(node: SourcemapNode, name: string): Array<SourcemapNode> {
	const found = node.name === name ? [node] : [];
	const children = node.children ?? [];
	for (const child of children) {
		found.push(...namedNodes(child, name));
	}

	return found;
}

function childNames(node: SourcemapNode): Array<string> {
	const children = node.children ?? [];
	return children.map((child) => child.name);
}

describe("synthesizer + rojo build integration", () => {
	it.skipIf(!rojoOnPath())(
		"should produce a project.json that rojo can build into a valid rbxl",
		() => {
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

			buildWithRojo(synthProjectPath, synthRbxlPath);

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
						luauRoot: "out",
						roots: ["out/shared/modules/ecs"],
						spine: resolveSpineDirectories(
							["out/shared/modules/ecs"],
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
							{ luauRoot: "out/shared/modules/ecs", shadowDir: shadowDirectory },
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
