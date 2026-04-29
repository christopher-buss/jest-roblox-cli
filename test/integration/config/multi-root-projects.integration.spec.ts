import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/loader.ts";
import { resolveAllProjects } from "../../../src/config/projects.ts";
import { rojoProjectSchema } from "../../../src/types/rojo.ts";
import { readJsonSync } from "../../e2e/cli/helpers.ts";

const MULTI_ROOT_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/multi-root-project");

async function resolveFixtureProjects() {
	const config = await loadConfig(undefined, MULTI_ROOT_FIXTURE);
	const rojoData = readJsonSync(path.join(MULTI_ROOT_FIXTURE, "default.project.json"));
	const rojo = rojoProjectSchema.assert(rojoData);

	return resolveAllProjects(
		config.projects ?? [],
		{ ...config, rootDir: MULTI_ROOT_FIXTURE },
		rojo.tree,
		MULTI_ROOT_FIXTURE,
	);
}

describe("multi-root projects", () => {
	it("should resolve multiple rojoMounts when a project spans services", async () => {
		expect.assertions(4);

		const resolved = await resolveFixtureProjects();

		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.rojoMounts).toHaveLength(2);

		const dataModelPaths = resolved[0]?.rojoMounts.map((mount) => mount.dataModelPath);

		expect(dataModelPaths).toContainEqual("ReplicatedStorage/PkgShared");
		expect(dataModelPaths).toContainEqual("ServerScriptService/PkgServer");
	});

	it("should leave outDir undefined when project spans multiple mounts", async () => {
		expect.assertions(1);

		const resolved = await resolveFixtureProjects();

		expect(resolved[0]?.outDir).toBeUndefined();
	});

	it("should mirror rojoMount dataModel paths in the projects array", async () => {
		expect.assertions(1);

		const resolved = await resolveFixtureProjects();
		const mountPaths = resolved[0]?.rojoMounts.map((mount) => mount.dataModelPath);

		expect(resolved[0]?.projects).toStrictEqual(mountPaths);
	});

	it("should pin to a single mount when outDir is set on the project", async () => {
		expect.assertions(2);

		const config = await loadConfig(undefined, MULTI_ROOT_FIXTURE);
		const rojoData = readJsonSync(path.join(MULTI_ROOT_FIXTURE, "default.project.json"));
		const rojo = rojoProjectSchema.assert(rojoData);

		const resolved = await resolveAllProjects(
			[
				{
					test: {
						displayName: "shared-only",
						include: ["pkg/src/**/*.spec.luau"],
						outDir: "pkg/src/Shared",
					},
				},
			],
			{ ...config, rootDir: MULTI_ROOT_FIXTURE },
			rojo.tree,
			MULTI_ROOT_FIXTURE,
		);

		expect(resolved[0]?.rojoMounts).toHaveLength(1);
		expect(resolved[0]?.rojoMounts[0]?.dataModelPath).toBe("ReplicatedStorage/PkgShared");
	});
});
