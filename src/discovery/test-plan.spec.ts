import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { PlanScope, PlanTestsInput, TestsPlan } from "./test-plan.ts";
import { ANY_PROJECT_EMPTY, planTests } from "./test-plan.ts";

interface ScopeOptions {
	name?: string;
	cliFiles?: Array<string>;
	config?: Partial<ResolvedConfig>;
	exclude?: Array<string>;
	include?: Array<string>;
	passWithNoTests?: boolean;
	typecheck?: TypecheckConfig;
}

function makeScope({
	name = "pkg",
	cliFiles,
	config = {},
	exclude = [],
	include = ["src/**/*.spec.ts"],
	passWithNoTests = false,
	typecheck,
}: ScopeOptions = {}): PlanScope {
	const rootDirectory = `/ws/${name}`;
	const project: ResolvedProjectConfig = fromAny({
		config: {},
		displayName: "main",
		exclude,
		include,
		projects: ["ReplicatedStorage.src"],
		rojoMounts: [],
		testMatch: ["**/*.spec"],
	});
	return {
		emptyMessage: `empty ${name}\n`,
		passWithNoTests,
		projects: [
			{
				cliFiles,
				config: {
					...createResolvedConfig(),
					rootDir: rootDirectory,
					testPathIgnorePatterns: [],
					...config,
				},
				project,
			},
		],
		rootDirectory,
		typecheck,
	};
}

function plan(scopes: Array<PlanScope>, files: ReadonlyArray<string>): TestsPlan {
	const { fileSystem, volume } = createMemoryFileSystem();
	for (const file of files) {
		volume.mkdirSync(path.posix.dirname(file), { recursive: true });
		volume.writeFileSync(file, "");
	}

	return planTests({
		cliTypecheck: {},
		fileSystem,
		scopes,
		summaryRoot: "/ws",
		tsconfigReader: vi.fn<PlanTestsInput["tsconfigReader"]>(() => null),
	});
}

function runtimeFiles(result: TestsPlan): Array<Array<string>> {
	return result.scopes.map(({ projects }) => projects.flatMap((entry) => entry.runtimeFiles));
}

describe(planTests, () => {
	it("should split one glob into runtime files and absolute type tests", () => {
		expect.assertions(2);

		const result = plan(
			[makeScope({ typecheck: { enabled: true } })],
			["/ws/pkg/src/a.spec.ts", "/ws/pkg/src/a.spec-d.ts"],
		);

		expect(runtimeFiles(result)).toStrictEqual([["src/a.spec.ts"]]);
		expect(result.typeTestEntries).toStrictEqual([
			{
				cwd: "/ws/pkg",
				files: [path.resolve("/ws/pkg", "src/a.spec-d.ts")],
				tsconfig: undefined,
			},
		]);
	});

	it("should drop the files a testPathIgnorePatterns entry matches", () => {
		expect.assertions(1);

		const result = plan(
			[makeScope({ config: { testPathIgnorePatterns: ["skip"] } })],
			["/ws/pkg/src/a.spec.ts", "/ws/pkg/src/skip.spec.ts"],
		);

		expect(runtimeFiles(result)).toStrictEqual([["src/a.spec.ts"]]);
	});

	it("should apply the exclude to discovered files but not to positional files", () => {
		expect.assertions(2);

		const files = ["/ws/pkg/src/a.spec.ts", "/ws/pkg/src/b.spec.ts"];

		expect(
			runtimeFiles(plan([makeScope({ exclude: ["src/b.spec.ts"] })], files)),
		).toStrictEqual([["src/a.spec.ts"]]);
		expect(
			runtimeFiles(
				plan(
					[makeScope({ cliFiles: ["src/b.spec.ts"], exclude: ["src/b.spec.ts"] })],
					files,
				),
			),
		).toStrictEqual([[path.resolve("/ws/pkg", "src/b.spec.ts")]]);
	});

	it("should apply the typecheck include and exclude to discovered type tests but not to positional ones", () => {
		expect.assertions(2);

		const typecheck = {
			enabled: true,
			exclude: ["types/b.spec-d.ts"],
			include: ["types/**/*.spec-d.ts"],
		};
		const files = ["/ws/pkg/types/a.spec-d.ts", "/ws/pkg/types/b.spec-d.ts"];

		expect(plan([makeScope({ typecheck })], files).typeTestEntries[0]!.files).toStrictEqual([
			path.resolve("/ws/pkg", "types/a.spec-d.ts"),
		]);
		expect(
			plan([makeScope({ cliFiles: ["types/b.spec-d.ts"], typecheck })], files)
				.typeTestEntries[0]!.files,
		).toStrictEqual([path.resolve("/ws/pkg", "types/b.spec-d.ts")]);
	});

	it("should filter runtime and type tests by testPathPattern and narrow the config", () => {
		expect.assertions(3);

		const result = plan(
			[makeScope({ config: { testPathPattern: "a\\.spec" }, typecheck: { enabled: true } })],
			[
				"/ws/pkg/src/a.spec.ts",
				"/ws/pkg/src/b.spec.ts",
				"/ws/pkg/src/a.spec-d.ts",
				"/ws/pkg/src/b.spec-d.ts",
			],
		);

		expect(runtimeFiles(result)).toStrictEqual([["src/a.spec.ts"]]);
		expect(result.typeTestEntries[0]!.files).toStrictEqual([
			path.resolve("/ws/pkg", "src/a.spec-d.ts"),
		]);
		expect(result.scopes[0]!.projects[0]!.config.testPathPattern).not.toBe("a\\.spec");
	});

	it.for([
		["src/*.spec.ts", "src/a.spec-d.ts", ["src/a.spec-d.ts"]],
		["src/*.test.ts", "src/a.test-d.ts", ["src/a.test-d.ts"]],
		["src/*.spec.luau", "src/a.spec-d.luau", ["src/a.spec-d.luau"]],
		["src/*.test.luau", "src/a.test-d.luau", ["src/a.test-d.luau"]],
		[
			"src/spec.helpers/*.spec.ts",
			"src/spec.helpers/a.spec-d.ts",
			["src/spec.helpers/a.spec-d.ts"],
		],
		["src/*.spec.tsx", "src/a.spec-d.tsx", []],
		["src/*.test.lua", "src/a.test-d.lua", []],
		["src/*.spec.ts.bak", "src/a.spec-d.ts.bak", []],
		["src/*_spec.ts", "src/a.spec-d.ts", []],
		["src/*.ts", "src/a.spec-d.ts", ["src/a.spec-d.ts"]],
		["src/*.spec.ts", "src/a.test-d.ts", []],
	] as const)(
		"should derive type tests from include %s only for a runtime test suffix",
		([include, typeFile, expected]) => {
			expect.assertions(1);

			const result = plan(
				[makeScope({ include: [include], typecheck: { enabled: true } })],
				[`/ws/pkg/${typeFile}`],
			);

			expect(result.typeTestEntries.flatMap(({ files }) => files)).toStrictEqual(
				expected.map((file) => path.resolve("/ws/pkg", file)),
			);
		},
	);

	it("should keep type tests out of the runtime files when typecheck is off", () => {
		expect.assertions(1);

		const result = plan([makeScope()], ["/ws/pkg/src/a.spec.ts", "/ws/pkg/src/a.spec-d.ts"]);

		expect(runtimeFiles(result)).toStrictEqual([["src/a.spec.ts"]]);
	});

	it("should fail each scope that found no test, unless it passes with no tests", () => {
		expect.assertions(1);

		const result = plan(
			[
				makeScope({ name: "a" }),
				makeScope({ name: "b", passWithNoTests: true }),
				makeScope({ name: "c" }),
				makeScope({ name: "d" }),
			],
			["/ws/d/src/d.spec.ts"],
		);

		expect(result.emptiness).toStrictEqual({
			validationExitCode: 2,
			validationMessage: "empty a\nempty c\n",
		});
	});

	it("should drop a scope whose tests the testPathPattern rejects", () => {
		expect.assertions(2);

		const config = { testPathPattern: "a\\.spec" };
		const result = plan(
			[makeScope({ name: "a", config }), makeScope({ name: "b", config })],
			["/ws/a/src/a.spec.ts", "/ws/b/src/b.spec.ts"],
		);

		expect(result.emptiness).toBeUndefined();
		expect(runtimeFiles(result)).toStrictEqual([["src/a.spec.ts"], []]);
	});

	it("should fail a run the testPathPattern leaves empty, unless every scope passes", () => {
		expect.assertions(3);

		const config = { testPathPattern: "none" };
		const files = ["/ws/a/src/a.spec.ts", "/ws/b/src/b.spec.ts"];

		expect(
			plan([makeScope({ name: "a", config }), makeScope({ name: "b", config })], files)
				.emptiness,
		).toStrictEqual({ validationExitCode: 2, validationMessage: ANY_PROJECT_EMPTY });
		expect(
			plan(
				[
					makeScope({ name: "a", config, passWithNoTests: true }),
					makeScope({ name: "b", config, passWithNoTests: true }),
				],
				files,
			).emptiness,
		).toStrictEqual({});
		expect(
			plan(
				[
					makeScope({ name: "a", config, passWithNoTests: true }),
					makeScope({ name: "b", config }),
				],
				files,
			).emptiness,
		).toStrictEqual({ validationExitCode: 2, validationMessage: ANY_PROJECT_EMPTY });
	});
});

describe("partial runs", () => {
	it("should anchor related causes at the supplied summary root", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const root = path.resolve("/ws");
		const result = planTests({
			cliTypecheck: {},
			fileSystem,
			partialRun: {
				files: [path.join(root, "a/src/main.ts"), path.join(root, "b/src/main.ts")],
				kind: "related",
			},
			scopes: [makeScope({ name: "a" }), makeScope({ name: "b" })],
			summaryRoot: root,
			tsconfigReader: () => null,
		});

		expect(result.affected!.cause).toStrictEqual({
			files: ["a/src/main.ts", "b/src/main.ts"],
			kind: "related",
		});
	});

	it("should summarize a partial run with no selected scopes", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const result = planTests({
			cliTypecheck: {},
			fileSystem,
			partialRun: { files: [], kind: "related" },
			scopes: [],
			summaryRoot: "/ws",
			tsconfigReader: () => null,
		});

		expect(result.affected).toStrictEqual({
			affected: 0,
			cause: { files: [], kind: "related" },
			total: 0,
		});
	});
});
