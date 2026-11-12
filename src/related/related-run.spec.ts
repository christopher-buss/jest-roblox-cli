import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { RelatedRunInput } from "./related-run.ts";
import { resolveRelatedRun } from "./related-run.ts";

const ROOT = path.resolve("/project");
const TREE: RojoTreeNode = {
	$className: "DataModel",
	ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
};

function gitReplying(stdoutByCommand: Record<string, string>): RelatedRunInput["seams"] {
	return {
		childProcess: { execFileSync: (_file, args) => stdoutByCommand[args.join(" ")] ?? "" },
	};
}

function resolve({
	rojoTree,
	...rest
}: Partial<Pick<RelatedRunInput, "seams">> &
	Pick<RelatedRunInput, "cli" | "rootConfig"> & {
		rojoTree: RojoTreeNode | undefined;
	}): ReturnType<typeof resolveRelatedRun> {
	return resolveRelatedRun({
		fileSystem: createMemoryFileSystem().fileSystem,
		readRojoTree: () => rojoTree,
		seams: gitReplying({}),
		timing: clockTimingCollector(),
		...rest,
	});
}

describe(resolveRelatedRun, () => {
	it("should resolve nothing on a full run", () => {
		expect.assertions(1);

		const run = resolve({
			cli: {},
			rojoTree: TREE,
			rootConfig: createResolvedConfig({ rootDir: ROOT }),
		});

		expect(run).toBeUndefined();
	});

	it("should resolve files against the root and mounts against the Rojo project folder", () => {
		expect.assertions(2);

		const run = resolve({
			cli: { related: ["src/a.luau"] },
			rojoTree: TREE,
			rootConfig: createResolvedConfig({
				rojoProject: "places/game.project.json",
				rootDir: ROOT,
			}),
		});

		expect(run!.files).toStrictEqual([path.join(ROOT, "src", "a.luau")]);
		expect(run!.scope.rojoRoots).toStrictEqual([posixPath(path.join(ROOT, "places", "src"))]);
	});

	it("should scope the files changed since the ref", () => {
		expect.assertions(2);

		const run = resolve({
			cli: { changed: "main" },
			rojoTree: TREE,
			rootConfig: createResolvedConfig({
				rojoProject: "default.project.json",
				rootDir: ROOT,
			}),
			seams: gitReplying({
				"diff --name-only --no-renames -z main...HEAD": "src/a.luau\0",
				"rev-parse --show-toplevel": `${ROOT}\n`,
			}),
		});

		expect(run).toMatchObject({
			files: [posixPath(path.join(ROOT, "src", "a.luau"))],
			kind: "changed",
			since: "main",
		});
		expect(run!.scope.rojoRoots).toStrictEqual([posixPath(path.join(ROOT, "src"))]);
	});

	it("should take the default lockfile triggers and no mounts without a Rojo tree", () => {
		expect.assertions(2);

		const run = resolve({
			cli: { related: ["src/a.luau"] },
			rojoTree: undefined,
			rootConfig: createResolvedConfig({ rootDir: ROOT }),
		});

		expect(run!.scope.rojoRoots).toStrictEqual([]);
		expect(run!.scope.forceRerunTriggers).toContain("pnpm-lock.yaml");
	});
});
