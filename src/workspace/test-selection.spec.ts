import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { CliOptions } from "../config/resolved-config.ts";
import type { PackageContext } from "./project-contexts.ts";
import { selectWorkspaceTests } from "./test-selection.ts";

const WORKSPACE = path.resolve("/workspace");

interface PackageOptions {
	name: string;
	passWithNoTests?: boolean;
	projectTypecheck?: TypecheckConfig;
	typecheck?: TypecheckConfig;
}

function makeProject(displayName: string, typecheck?: TypecheckConfig): ResolvedProjectConfig {
	return fromAny({
		config: { ...createResolvedConfig() },
		displayName,
		exclude: [],
		include: [`${displayName}/**/*.spec.ts`],
		projects: [`ServerScriptService/${displayName}`],
		rojoMounts: [{ dataModelPath: `ServerScriptService/${displayName}`, fsPath: displayName }],
		testMatch: ["**/*.spec"],
		typecheck,
	});
}

function makeContext({
	name,
	passWithNoTests = false,
	projectTypecheck,
	typecheck,
}: PackageOptions): PackageContext {
	const packageDirectory = path.join(WORKSPACE, name);
	return fromAny({
		info: { name, packageDirectory },
		pkgConfig: {
			...createResolvedConfig(),
			passWithNoTests,
			rootDir: packageDirectory,
			timeout: 5000,
			typecheck,
		},
		projects: [makeProject("main", projectTypecheck), makeProject("other")],
	});
}

function select({
	cli = {},
	contexts,
	files,
}: {
	cli?: Partial<CliOptions>;
	contexts: Array<PackageContext>;
	files: Record<string, string>;
}) {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(
			Object.entries(files).map(([file, content]) => [path.join(WORKSPACE, file), content]),
		),
	);
	return selectWorkspaceTests({
		cli: fromAny(cli),
		contexts,
		cwd: WORKSPACE,
		fileSystem,
		runnerTiming: true,
		tsconfigReader: () => null,
		workspaceRoot: WORKSPACE,
	});
}

describe(selectWorkspaceTests, () => {
	it("should select nothing for an explicit empty project list", () => {
		expect.assertions(1);

		const selection = select({
			cli: { project: [] },
			contexts: [makeContext({ name: "foo" })],
			files: { "foo/main/a.spec.ts": "" },
		});

		expect(selection.filteredContexts).toStrictEqual([]);
	});

	it("should intersect names and positional files from the invocation directory", () => {
		expect.assertions(1);

		const selection = select({
			cli: { files: ["foo/main/a.spec.ts", "foo/other/b.spec.ts"], project: ["main"] },
			contexts: [makeContext({ name: "foo" }), makeContext({ name: "bar" })],
			files: { "foo/main/a.spec.ts": "", "foo/other/b.spec.ts": "" },
		});

		expect(
			selection.pending.map((entry) => ({ files: entry.job.testFiles, pkg: entry.job.pkg })),
		).toStrictEqual([{ files: [path.join(WORKSPACE, "foo/main/a.spec.ts")], pkg: "foo" }]);
	});

	it("should keep positional files with their package even when names repeat", () => {
		expect.assertions(1);

		const selection = select({
			cli: { files: ["foo/main/a.spec.ts", "bar/main/b.spec.ts"] },
			contexts: [makeContext({ name: "foo" }), makeContext({ name: "bar" })],
			files: {
				"bar/main/b.spec.ts": "",
				"bar/main/unselected.spec.ts": "",
				"foo/main/a.spec.ts": "",
				"foo/main/unselected.spec.ts": "",
			},
		});

		expect(
			selection.pending.map((entry) => ({ files: entry.job.testFiles, pkg: entry.job.pkg })),
		).toStrictEqual([
			{ files: [path.join(WORKSPACE, "foo/main/a.spec.ts")], pkg: "foo" },
			{ files: [path.join(WORKSPACE, "bar/main/b.spec.ts")], pkg: "bar" },
		]);
	});

	it("should retain an empty package for empty-run validation without filters", () => {
		expect.assertions(1);

		const ctx = makeContext({ name: "empty" });
		ctx.projects = [];
		const selection = select({
			contexts: [ctx, makeContext({ name: "foo" })],
			files: { "foo/main/a.spec.ts": "" },
		});

		expect(selection.emptiness).toMatchObject({
			validationMessage: "No test files found in package empty\n",
		});
	});

	it("should retain an empty package when the positional file list is empty", () => {
		expect.assertions(1);

		const ctx = makeContext({ name: "empty" });
		ctx.projects = [];
		const selection = select({ cli: { files: [] }, contexts: [ctx], files: {} });

		expect(selection.emptiness).toMatchObject({
			validationMessage: "No test files found in package empty\n",
		});
	});

	it("should build each job and stub its project with the resolved snapshot format", () => {
		expect.assertions(4);

		const selection = select({
			contexts: [makeContext({ name: "foo" })],
			files: { "foo/main/a.spec.ts": "" },
		});
		const [entry] = selection.pending;

		expect(entry!.job.pkg).toBe("foo");
		expect(entry!.job.argv).toMatchObject({ runnerTiming: true });
		expect(entry!.job.config.snapshotFormat).toStrictEqual({ printBasicPrototype: false });
		expect(entry!.project.config.snapshotFormat).toStrictEqual({ printBasicPrototype: false });
	});

	it("should collect runtime specs and type tests per package", () => {
		expect.assertions(4);

		const fooDirectory = path.join(WORKSPACE, "foo");
		const selection = select({
			contexts: [
				makeContext({
					name: "foo",
					typecheck: { enabled: true, ignoreSourceErrors: true },
				}),
				makeContext({ name: "bar", typecheck: { enabled: true } }),
			],
			files: {
				"bar/main/b.spec.ts": "",
				"foo/main/a.spec-d.ts": "",
				"foo/main/a.spec.ts": "",
				"foo/main/skip.spec-d.ts": "",
			},
		});

		expect(selection.pending.map((entry) => entry.job.testFiles)).toStrictEqual([
			["main/a.spec.ts"],
			["main/b.spec.ts"],
		]);
		expect(selection.typeTestEntries).toStrictEqual([
			{
				cwd: fooDirectory,
				files: [
					path.join(fooDirectory, "main/a.spec-d.ts"),
					path.join(fooDirectory, "main/skip.spec-d.ts"),
				],
				tsconfig: undefined,
			},
		]);
		expect(selection.typeTestProjects).toStrictEqual([{ pkg: "foo", project: "main" }]);
		expect([...selection.typecheckByDirectory]).toStrictEqual([
			[
				fooDirectory,
				{ ignoreSourceErrors: true, pkg: "foo", spawnTimeout: undefined, timeout: 5000 },
			],
		]);
	});

	it("should report an empty package unless it passes with no tests or has type tests", () => {
		expect.assertions(2);

		const selection = select({
			cli: { typecheckOnly: true },
			contexts: [
				makeContext({ name: "empty" }),
				makeContext({ name: "lenient", passWithNoTests: true }),
				makeContext({ name: "typed" }),
			],
			files: {
				"empty/main/a.spec.ts": "",
				"lenient/main/a.spec.ts": "",
				"typed/main/a.spec-d.ts": "",
			},
		});

		expect(selection.emptiness).toStrictEqual({
			validationExitCode: 2,
			validationMessage: "No test files found in package empty\n",
		});
		expect(selection.pending).toStrictEqual([]);
	});

	it("should drop empty projects inside a populated package", () => {
		expect.assertions(1);

		const selection = select({
			contexts: [makeContext({ name: "foo" })],
			files: { "foo/main/a.spec.ts": "" },
		});

		expect(selection.pending.map((entry) => entry.job.config.projects)).toStrictEqual([
			["ServerScriptService/main"],
		]);
	});

	it("should narrow to named projects before named files", () => {
		expect.assertions(2);

		const selection = select({
			cli: { project: ["main"] },
			contexts: [makeContext({ name: "foo" })],
			files: { "foo/main/a.spec.ts": "", "foo/other/b.spec.ts": "" },
		});

		expect(
			selection.filteredContexts.map((ctx) => {
				return ctx.projects.map((project) => project.displayName);
			}),
		).toStrictEqual([["main"]]);
		expect(selection.pending.map((entry) => entry.job.testFiles)).toStrictEqual([
			["main/a.spec.ts"],
		]);
	});

	it("should run only the type tests a positional file names", () => {
		expect.assertions(2);

		const selection = select({
			cli: { files: ["foo/main/a.spec-d.ts"] },
			contexts: [makeContext({ name: "foo", typecheck: { enabled: true } })],
			files: { "foo/main/a.spec-d.ts": "", "foo/main/b.spec-d.ts": "" },
		});

		expect(selection.typeTestEntries.map((entry) => entry.files)).toStrictEqual([
			[path.join(WORKSPACE, "foo/main/a.spec-d.ts")],
		]);
		expect(selection.emptiness).toBeUndefined();
	});
});
