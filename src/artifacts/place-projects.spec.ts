import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { RunDispatch } from "../run.ts";
import type { RunSeams } from "../run/seams.ts";
import { resolveProjectsAsync } from "./place-projects.ts";

function makeProject(displayName: string): ResolvedProjectConfig {
	return fromAny({ displayName });
}

function setup() {
	const { fileSystem } = createMemoryFileSystem({});
	const implicit = makeProject("implicit");
	const declared = makeProject("declared");
	const dispatch = fromAny<RunDispatch, Partial<RunDispatch>>({
		buildImplicitProject: vi
			.fn<RunDispatch["buildImplicitProject"]>()
			.mockReturnValue(implicit),
		loadRojoTree: vi.fn<RunDispatch["loadRojoTree"]>(),
	});
	const seams = createRunSeams({
		resolveAllProjects: vi.fn<RunSeams["resolveAllProjects"]>().mockResolvedValue([declared]),
	});
	return { declared, implicit, options: { dispatch, fileSystem, seams } };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...createResolvedConfig(), rootDir: "/test", ...overrides };
}

describe(resolveProjectsAsync, () => {
	it("should resolve declared projects through the seam", async () => {
		expect.assertions(2);

		const { declared, options } = setup();
		const projects: NonNullable<ResolvedConfig["projects"]> = [
			fromAny({ test: { displayName: "declared" } }),
		];

		const result = await resolveProjectsAsync(makeConfig({ projects }), options);

		expect(result).toStrictEqual([declared]);
		expect(options.dispatch.buildImplicitProject).not.toHaveBeenCalled();
	});

	it("should collapse a config without projects to the implicit project", async () => {
		expect.assertions(2);

		const { implicit, options } = setup();

		const result = await resolveProjectsAsync(makeConfig({ projects: undefined }), options);

		expect(result).toStrictEqual([implicit]);
		expect(options.seams.resolveAllProjects).not.toHaveBeenCalled();
	});

	it("should collapse an empty projects list to the implicit project", async () => {
		expect.assertions(1);

		const { implicit, options } = setup();

		const result = await resolveProjectsAsync(makeConfig({ projects: [] }), options);

		expect(result).toStrictEqual([implicit]);
	});
});
