import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { BuildImplicitProjectOptions } from "../config/implicit-project.ts";
import { buildImplicitProject } from "./implicit-project.ts";

describe(buildImplicitProject, () => {
	it("should retain the run layer's implicit project entry point", () => {
		expect.assertions(1);

		const options = {
			config: createResolvedConfig({ luauRoots: ["out"], rootDir: "/pkg" }),
			fileSystem: createMemoryFileSystem().fileSystem,
			rojoTree: { $className: "DataModel", ReplicatedStorage: { Pkg: { $path: "out" } } },
			tsconfigReader: () => null,
		} satisfies BuildImplicitProjectOptions;

		expect(buildImplicitProject(options).projects).toStrictEqual(["ReplicatedStorage/Pkg"]);
	});
});
