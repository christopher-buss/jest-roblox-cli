import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { PlannedProject } from "../discovery/test-plan.ts";
import { buildPlannedJob } from "./planned-job.ts";

function makePlanned(): PlannedProject {
	return fromAny({
		config: { ...createResolvedConfig(), rootDir: "/repo" },
		project: {
			config: { rootDir: "/repo" },
			displayColor: "cyan",
			displayName: "unit",
		},
		runtimeFiles: ["src/a.spec.ts"],
	});
}

describe(buildPlannedJob, () => {
	it("should build the job and hand back the project with its resolved snapshot format", () => {
		expect.assertions(2);

		const { job, project } = buildPlannedJob({
			fileSystem: createMemoryFileSystem().fileSystem,
			planned: makePlanned(),
			runnerTiming: true,
			runtimeInjectionPaths: ["ServerScriptService/unit"],
			tsconfigCache: new Map(),
			tsconfigReader: () => null,
		});

		expect(job).toMatchObject({
			argv: { runnerTiming: true },
			config: { snapshotFormat: { printBasicPrototype: false } },
			displayColor: "cyan",
			displayName: "unit",
			runtimeInjectionPaths: ["ServerScriptService/unit"],
			testFiles: ["src/a.spec.ts"],
		});
		expect(project).toStrictEqual(
			fromAny<ResolvedProjectConfig, unknown>({
				config: { rootDir: "/repo", snapshotFormat: { printBasicPrototype: false } },
				displayColor: "cyan",
				displayName: "unit",
			}),
		);
	});
});
