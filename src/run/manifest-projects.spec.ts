import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import { toBuildManifestProjects } from "./manifest-projects.ts";

describe(toBuildManifestProjects, () => {
	it("should map a resolved project to one entry per DataModel mount", () => {
		expect.assertions(1);

		const projects: Array<ResolvedProjectConfig> = fromAny([
			{
				config: { jestPath: "RS/jest", setupFiles: ["RS/setup"], setupFilesAfterEnv: [] },
				displayName: "client",
				projects: ["ReplicatedStorage/client"],
				testMatch: ["**/*.spec"],
			},
		]);

		expect(toBuildManifestProjects(projects)).toStrictEqual([
			{
				displayName: "client",
				jestDataModelPath: "RS/jest",
				projectDataModelPath: "ReplicatedStorage/client",
				setupFiles: ["RS/setup"],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
		]);
	});

	it("should emit one entry per mount, omitting jestDataModelPath and defaulting setup files", () => {
		expect.assertions(1);

		const projects: Array<ResolvedProjectConfig> = fromAny([
			{
				config: {},
				displayName: "shared",
				projects: ["ReplicatedStorage/a", "ServerScriptService/b"],
				testMatch: ["**/*.spec"],
			},
		]);

		expect(toBuildManifestProjects(projects)).toStrictEqual([
			{
				displayName: "shared",
				projectDataModelPath: "ReplicatedStorage/a",
				setupFiles: [],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
			{
				displayName: "shared",
				projectDataModelPath: "ServerScriptService/b",
				setupFiles: [],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
		]);
	});
});
