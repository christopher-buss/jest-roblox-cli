import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { fakeTimingCollector, phaseNamesOf } from "#test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { readRunRojoTree, resolveRunProjectsAsync } from "./single-projects.ts";

const tree: RojoTreeNode = fromAny({
	$className: "DataModel",
	ReplicatedStorage: { Shared: { $path: "out/shared" } },
	ServerScriptService: { Server: { $path: "out/server" } },
});

describe(resolveRunProjectsAsync, () => {
	it("should time the Rojo tree load of the implicit project", async () => {
		expect.assertions(1);

		const timing = fakeTimingCollector();
		const { fileSystem } = createMemoryFileSystem({
			[path.resolve("/pkg/default.project.json")]: JSON.stringify({ name: "pkg", tree }),
		});

		await resolveRunProjectsAsync({
			cliTypecheck: {},
			fileSystem,
			rootConfig: fromAny({
				...createResolvedConfig(),
				luauRoots: ["out/shared"],
				rojoProject: path.resolve("/pkg/default.project.json"),
				rootDir: "/pkg",
			}),
			seams: fromAny({ tsconfigReader: () => null }),
			timing,
		});

		expect(phaseNamesOf(timing.profile)).toContain("loadRojoTree");
	});
});

describe(readRunRojoTree, () => {
	function readWith(only: boolean): RojoTreeNode | undefined {
		const { fileSystem } = createMemoryFileSystem({
			[path.resolve("/pkg/default.project.json")]: JSON.stringify({ name: "pkg", tree }),
		});
		return readRunRojoTree({
			cliTypecheck: { only },
			fileSystem,
			rootConfig: createResolvedConfig({
				rojoProject: path.resolve("/pkg/default.project.json"),
				rootDir: "/pkg",
			}),
		});
	}

	it("should read the Rojo tree of a run with runtime tests", () => {
		expect.assertions(1);

		expect(readWith(false)).toMatchObject({ $className: "DataModel" });
	});

	it("should read no Rojo tree on a typecheck-only run", () => {
		expect.assertions(1);

		expect(readWith(true)).toBeUndefined();
	});
});
