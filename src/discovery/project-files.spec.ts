import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { RelatedFileFilter } from "../related/related-tests.ts";
import type { ProjectSelection, ProjectSelectionInput } from "./project-files.ts";
import { selectProjectFiles } from "./project-files.ts";

function makeProject(overrides: Partial<ResolvedProjectConfig> = {}): ResolvedProjectConfig {
	return fromAny({
		config: { ...createResolvedConfig(), rootDir: "/test", testPathIgnorePatterns: [] },
		displayName: "main",
		exclude: [],
		include: ["src/**/*.spec.ts"],
		projects: ["ReplicatedStorage.src"],
		rojoMounts: [],
		testMatch: ["**/*.spec"],
		...overrides,
	});
}

function makeTypecheck(overrides: Partial<ResolvedTypecheckConfig> = {}): ResolvedTypecheckConfig {
	return fromAny({ enabled: false, only: false, ...overrides });
}

function select(
	files: Record<string, string>,
	input: Partial<ProjectSelectionInput> = {},
): ProjectSelection {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(
			Object.entries(files).map(([file, source]) => [path.resolve("/test", file), source]),
		),
	);
	return selectProjectFiles({
		fileSystem,
		filterRelated: undefined,
		project: makeProject(),
		projectCliFiles: undefined,
		toInstancePath: () => {},
		typecheck: makeTypecheck(),
		...input,
	});
}

describe(selectProjectFiles, () => {
	it("should apply the project exclude to discovered files", () => {
		expect.assertions(1);

		const selection = select(
			{ "src/a.spec.ts": "", "src/b.spec.ts": "" },
			{ project: makeProject({ exclude: ["src/b.spec.ts"] }) },
		);

		expect(selection.runtimeFiles).toStrictEqual(["src/a.spec.ts"]);
	});

	it("should keep positional files past the project exclude", () => {
		expect.assertions(1);

		const selection = select(
			{ "src/b.spec.ts": "" },
			{
				project: makeProject({ exclude: ["src/b.spec.ts"] }),
				projectCliFiles: ["src/b.spec.ts"],
			},
		);

		expect(selection.runtimeFiles).toStrictEqual([path.resolve("/test", "src/b.spec.ts")]);
	});

	it("should honor the typecheck include and exclude", () => {
		expect.assertions(1);

		const selection = select(
			{ "types/a.spec-d.ts": "", "types/b.spec-d.ts": "" },
			{
				typecheck: makeTypecheck({
					enabled: true,
					exclude: ["types/b.spec-d.ts"],
					include: ["types/**/*.spec-d.ts"],
				}),
			},
		);

		expect(selection.typeTestFiles).toStrictEqual(["types/a.spec-d.ts"]);
	});

	it("should keep positional type tests past the typecheck exclude", () => {
		expect.assertions(1);

		const selection = select(
			{ "types/b.spec-d.ts": "" },
			{
				projectCliFiles: ["types/b.spec-d.ts"],
				typecheck: makeTypecheck({ enabled: true, exclude: ["types/b.spec-d.ts"] }),
			},
		);

		expect(selection.typeTestFiles).toStrictEqual([path.resolve("/test", "types/b.spec-d.ts")]);
	});

	it("should leave the Luau pattern undefined on a bare run", () => {
		expect.assertions(1);

		const selection = select({ "src/a.spec.ts": "" });

		expect(selection.config.testPathPattern).toBeUndefined();
	});

	it("should keep only the related tests and narrow to them", () => {
		expect.assertions(1);

		const rojoProject = path.resolve("/test", "default.project.json");
		const related = new Set(
			["src/a.spec-d.luau", "src/a.spec.luau"].map((file) => {
				return JSON.stringify([rojoProject, path.resolve("/test", file)]);
			}),
		);
		function filterRelated(
			files: Array<string>,
			{ rojoProjectPath, rootDirectory }: Parameters<RelatedFileFilter>[1],
		): Array<string> {
			return files.filter((file) => {
				return related.has(
					JSON.stringify([rojoProjectPath, path.resolve(rootDirectory, file)]),
				);
			});
		}

		const selection = select(
			{
				"src/a.spec-d.luau": "",
				"src/a.spec.luau": "",
				"src/b.spec-d.luau": "",
				"src/b.spec.luau": "",
			},
			{
				filterRelated,
				project: makeProject({
					config: {
						...createResolvedConfig(),
						rojoProject,
						rootDir: "/test",
						testPathIgnorePatterns: [],
					},
					include: ["src/**/*.spec.luau"],
				}),
				typecheck: makeTypecheck({ enabled: true }),
			},
		);

		expect(selection).toMatchObject({
			config: { testPathPattern: "(a\\.spec)" },
			runtimeCandidateCount: 2,
			runtimeFiles: ["src/a.spec.luau"],
			typeTestFiles: ["src/a.spec-d.luau"],
		});
	});
});
