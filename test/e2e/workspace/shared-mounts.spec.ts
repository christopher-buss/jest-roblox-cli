import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkspacePackage } from "#test/e2e/cli/workspace-place.ts";
import { synthesizeWorkspaceAsync } from "#test/e2e/cli/workspace-place.ts";
import {
	childNames,
	namedNodes,
	nodesBuiltFrom,
	readSourcemap,
} from "#test/e2e/workspace/sourcemap.ts";
import { rojoOnPath } from "#test/harness/helpers.ts";

/** One file, mounted from every package in a workspace run. */
const SHARED_STUB = { Config: { $path: "../../shared-config.luau" } };

const PROBE_SPEC = "return {}\n";

/**
 * A package whose test project mounts its own `src` plus whatever `shared`
 * declares under `ReplicatedStorage`, the shape every package in a real
 * workspace has, differing only in what it mounts beside its sources.
 * @param name - Name for the package and its directory.
 * @param shared - What the package mounts beside its own sources.
 * @returns A workspace package that mounts `shared`.
 */
function sharingPackage(name: string, shared: Record<string, unknown>): WorkspacePackage {
	return {
		name,
		config: { luauRoots: ["tests"] },
		files: { [`src/${name}.luau`]: PROBE_SPEC, [`tests/${name}.spec.luau`]: PROBE_SPEC },
		tree: {
			ReplicatedStorage: {
				...shared,
				$className: "ReplicatedStorage",
				Src: { $path: "src" },
			},
			ServerScriptService: { $className: "ServerScriptService", Tests: { $path: "tests" } },
		},
	};
}

describe.skipIf(!rojoOnPath())("workspace place shared mounts", () => {
	it("should build a single file two packages mount into the place once", async () => {
		expect.assertions(3);

		const { projectPath, root: workspace } = await synthesizeWorkspaceAsync({
			files: { "shared-config.luau": "return {}\n" },
			packages: [sharingPackage("foo", SHARED_STUB), sharingPackage("bar", SHARED_STUB)],
		});
		const stub = path.join(workspace, "shared-config.luau");

		const root = readSourcemap(projectPath);
		const [pool] = namedNodes(root, "__shared");

		expect(nodesBuiltFrom(root, stub)).toHaveLength(1);
		expect(nodesBuiltFrom(pool!, stub)).toHaveLength(1);
		expect(namedNodes(root, "Config").map((node) => childNames(node))).toStrictEqual([[], []]);
	});

	it("should build one Instance per directory when a coverage spine nests", async () => {
		expect.assertions(4);

		const { projectPath } = await synthesizeWorkspaceAsync({
			args: ["--coverage"],
			packages: [
				{
					name: "foo",
					config: {
						luauRoots: ["out"],
						rootDir: ".",
						test: { collectCoverageFrom: ["out/shared/modules/ecs/**"] },
					},
					files: {
						"out/loose.luau": "return {}\n",
						"out/probe.spec.luau": PROBE_SPEC,
						"out/shared/log-config.luau": "return {}\n",
						"out/shared/modules/ecs/world.luau": "return {}\n",
						"out/shared/modules/net.luau": "return {}\n",
						"out/shared/modules/utilities/helper.luau": "return {}\n",
					},
					tree: { ReplicatedStorage: { $className: "ReplicatedStorage", $path: "out" } },
				},
			],
		});

		const root = readSourcemap(projectPath);

		// A spine level whose mount still contained the level below it would
		// build that level twice, once auto-mounted through the `$path` and
		// once as the explicit child the demote hangs beside it, and
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
	});
});
