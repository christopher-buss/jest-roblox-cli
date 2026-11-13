import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { matchFilesToProjects } from "./filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "./projects.ts";

function filterProjectsByFiles({
	files,
	projects,
	rootDirectory,
}: {
	files: Array<string>;
	projects: Array<ResolvedProjectConfig>;
	rootDirectory: string;
}) {
	return matchFilesToProjects({
		fileBase: rootDirectory,
		files,
		scopes: projects.map((project) => ({ project, rootDirectory })),
	}).map(({ files: matched, scope }) => {
		return { matchingFiles: matched.map((file) => file.original), project: scope.project };
	});
}

function makeProject(overrides: Partial<ResolvedProjectConfig> = {}): ResolvedProjectConfig {
	return {
		config: fromAny({}),
		displayName: "client",
		exclude: [],
		include: ["src/client/**/*.spec.ts"],
		projects: [],
		rojoMounts: [],
		testMatch: ["**/*.spec"],
		...overrides,
	};
}

function filterClientServerAcrossFiles(): ReturnType<typeof filterProjectsByFiles> {
	const client = makeProject({
		displayName: "client",
		include: ["src/client/**/*.spec.ts"],
	});
	const server = makeProject({
		displayName: "server",
		include: ["src/server/**/*.spec.ts"],
	});

	return filterProjectsByFiles({
		files: ["src/client/a.spec.ts", "src/server/b.spec.ts"],
		projects: [client, server],
		rootDirectory: "/repo",
	});
}

describe(filterProjectsByFiles, () => {
	it("should return only the project whose include root contains the file", () => {
		expect.assertions(2);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});
		const server = makeProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/client/foo.spec.ts"],
			projects: [client, server],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.project.displayName).toBe("client");
	});

	it("should return projects matching across multiple positional files", () => {
		expect.assertions(2);

		const result = filterClientServerAcrossFiles();

		expect(result).toHaveLength(2);
		expect(result.map((match) => match.project.displayName)).toStrictEqual([
			"client",
			"server",
		]);
	});

	it("should pair each project with only the cli files its roots contain", () => {
		expect.assertions(2);

		const result = filterClientServerAcrossFiles();

		expect(result[0]!.matchingFiles).toStrictEqual(["src/client/a.spec.ts"]);
		expect(result[1]!.matchingFiles).toStrictEqual(["src/server/b.spec.ts"]);
	});

	it("should give overlapping projects each only their owning files", () => {
		expect.assertions(2);

		const wide = makeProject({
			displayName: "wide",
			include: ["src/**/*.spec.ts"],
		});
		const narrow = makeProject({
			displayName: "narrow",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/client/a.spec.ts", "src/server/b.spec.ts"],
			projects: [wide, narrow],
			rootDirectory: "/repo",
		});

		// Wide root `src` contains both files; narrow root `src/client` contains
		// only `a`.
		expect(result[0]!.matchingFiles).toStrictEqual([
			"src/client/a.spec.ts",
			"src/server/b.spec.ts",
		]);
		expect(result[1]!.matchingFiles).toStrictEqual(["src/client/a.spec.ts"]);
	});

	it("should return projects in the same order as the input list", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});
		const server = makeProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/server/b.spec.ts", "src/client/a.spec.ts"],
			projects: [client, server],
			rootDirectory: "/repo",
		});

		expect(result.map((match) => match.project.displayName)).toStrictEqual([
			"client",
			"server",
		]);
	});

	it("should include a project once when multiple files match its roots", () => {
		expect.assertions(2);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/client/a.spec.ts", "src/client/b.spec.ts"],
			projects: [client],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.matchingFiles).toStrictEqual([
			"src/client/a.spec.ts",
			"src/client/b.spec.ts",
		]);
	});

	it("should include a project when one of its multiple include roots contains the file", () => {
		expect.assertions(1);

		const shared = makeProject({
			displayName: "shared",
			include: ["src/shared/**/*.spec.ts", "src/util/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/util/x.spec.ts"],
			projects: [shared],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should include all projects whose roots contain the file (overlapping mounts)", () => {
		expect.assertions(1);

		const wide = makeProject({
			displayName: "wide",
			include: ["src/**/*.spec.ts"],
		});
		const narrow = makeProject({
			displayName: "narrow",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/client/foo.spec.ts"],
			projects: [wide, narrow],
			rootDirectory: "/repo",
		});

		expect(result.map((match) => match.project.displayName)).toStrictEqual(["wide", "narrow"]);
	});

	it("should normalize Windows backslash paths when matching", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src\\client\\foo.spec.ts"],
			projects: [client],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should normalize Windows backslashes inside include patterns", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src\\client\\**\\*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/client/foo.spec.ts"],
			projects: [client],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should resolve relative cli files against rootDirectory before matching", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		// Relative path: must be resolved under `/repo` to match the project
		// root.
		const result = filterProjectsByFiles({
			files: ["src/client/foo.spec.ts"],
			projects: [client],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should select a project when the requested path is its include root", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["src/client"],
			projects: [client],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should accept absolute POSIX cli file paths under rootDirectory", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["/repo/src/client/foo.spec.ts"],
			projects: [client],
			rootDirectory: "/repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should accept absolute Windows cli file paths under rootDirectory", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles({
			files: ["D:\\repo\\src\\client\\foo.spec.ts"],
			projects: [client],
			rootDirectory: "D:\\repo",
		});

		expect(result).toHaveLength(1);
	});

	it("should throw with a clear message listing every file and root when nothing matches", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});
		const server = makeProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
		});

		expect(() => {
			return filterProjectsByFiles({
				files: ["src/shared/foo.spec.ts", "src/common/bar.spec.ts"],
				projects: [client, server],
				rootDirectory: "/repo",
			});
		}).toThrow(
			[
				"No project contains the requested file(s):",
				"  - src/shared/foo.spec.ts",
				"  - src/common/bar.spec.ts",
				"",
				"Project roots searched:",
				"  - /repo/src/client",
				"  - /repo/src/server",
			].join("\n"),
		);
	});

	it("should report no roots when no projects are supplied", () => {
		expect.assertions(1);

		expect(() => {
			return filterProjectsByFiles({
				files: ["src/foo.spec.ts"],
				projects: [],
				rootDirectory: "/repo",
			});
		}).toThrow(
			"  (none: projects use include patterns with no static directory prefix; pass --project explicitly)",
		);
	});

	it("should not assign files to a project with no include patterns", () => {
		expect.assertions(1);

		const empty = makeProject({ include: [] });
		const client = makeProject();

		expect(
			filterProjectsByFiles({
				files: ["src/client/a.spec.ts"],
				projects: [empty, client],
				rootDirectory: "/repo",
			}),
		).toStrictEqual([{ matchingFiles: ["src/client/a.spec.ts"], project: client }]);
	});

	it("should resolve includes without a static prefix against the project directory", () => {
		expect.assertions(1);

		const wildcard = makeProject({ displayName: "wildcard", include: ["**/*.spec.ts"] });

		expect(
			filterProjectsByFiles({
				files: ["src/foo.spec.ts"],
				projects: [wildcard],
				rootDirectory: "/repo",
			}),
		).toStrictEqual([{ matchingFiles: ["src/foo.spec.ts"], project: wildcard }]);
	});
});
