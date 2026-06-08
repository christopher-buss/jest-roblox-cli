import { describe, expect, it } from "vitest";

import { filterProjectsByFiles } from "./filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "./projects.ts";

function makeProject(overrides: Partial<ResolvedProjectConfig> = {}): ResolvedProjectConfig {
	return {
		config: {} as unknown as ResolvedProjectConfig["config"],
		displayName: "client",
		exclude: [],
		include: ["src/client/**/*.spec.ts"],
		projects: [],
		rojoMounts: [],
		testMatch: ["**/*.spec"],
		...overrides,
	};
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

		const result = filterProjectsByFiles([client, server], ["src/client/foo.spec.ts"], "/repo");

		expect(result).toHaveLength(1);
		expect(result[0]?.project.displayName).toBe("client");
	});

	it("should return projects matching across multiple positional files", () => {
		expect.assertions(2);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});
		const server = makeProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles(
			[client, server],
			["src/client/a.spec.ts", "src/server/b.spec.ts"],
			"/repo",
		);

		expect(result).toHaveLength(2);
		expect(result.map((match) => match.project.displayName)).toStrictEqual([
			"client",
			"server",
		]);
	});

	it("should pair each project with only the cli files its roots contain", () => {
		expect.assertions(2);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});
		const server = makeProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles(
			[client, server],
			["src/client/a.spec.ts", "src/server/b.spec.ts"],
			"/repo",
		);

		expect(result[0]?.matchingFiles).toStrictEqual(["src/client/a.spec.ts"]);
		expect(result[1]?.matchingFiles).toStrictEqual(["src/server/b.spec.ts"]);
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

		const result = filterProjectsByFiles(
			[wide, narrow],
			["src/client/a.spec.ts", "src/server/b.spec.ts"],
			"/repo",
		);

		// Wide root `src` contains both files; narrow root `src/client` contains
		// only `a`.
		expect(result[0]?.matchingFiles).toStrictEqual([
			"src/client/a.spec.ts",
			"src/server/b.spec.ts",
		]);
		expect(result[1]?.matchingFiles).toStrictEqual(["src/client/a.spec.ts"]);
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

		const result = filterProjectsByFiles(
			[client, server],
			["src/server/b.spec.ts", "src/client/a.spec.ts"],
			"/repo",
		);

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

		const result = filterProjectsByFiles(
			[client],
			["src/client/a.spec.ts", "src/client/b.spec.ts"],
			"/repo",
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.matchingFiles).toStrictEqual([
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

		const result = filterProjectsByFiles([shared], ["src/util/x.spec.ts"], "/repo");

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

		const result = filterProjectsByFiles([wide, narrow], ["src/client/foo.spec.ts"], "/repo");

		expect(result.map((match) => match.project.displayName)).toStrictEqual(["wide", "narrow"]);
	});

	it("should normalize Windows backslash paths when matching", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles([client], ["src\\client\\foo.spec.ts"], "/repo");

		expect(result).toHaveLength(1);
	});

	it("should normalize Windows backslashes inside include patterns", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src\\client\\**\\*.spec.ts"],
		});

		const result = filterProjectsByFiles([client], ["src/client/foo.spec.ts"], "/repo");

		expect(result).toHaveLength(1);
	});

	it("should resolve relative cli files against rootDirectory before matching", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		// Relative path — must be resolved under `/repo` to match the project
		// root.
		const result = filterProjectsByFiles([client], ["src/client/foo.spec.ts"], "/repo");

		expect(result).toHaveLength(1);
	});

	it("should accept absolute POSIX cli file paths under rootDirectory", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles([client], ["/repo/src/client/foo.spec.ts"], "/repo");

		expect(result).toHaveLength(1);
	});

	it("should accept absolute Windows cli file paths under rootDirectory", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});

		const result = filterProjectsByFiles(
			[client],
			["D:\\repo\\src\\client\\foo.spec.ts"],
			"D:\\repo",
		);

		expect(result).toHaveLength(1);
	});

	it("should throw with a clear message listing files and roots when nothing matches", () => {
		expect.assertions(1);

		const client = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
		});
		const server = makeProject({
			displayName: "server",
			include: ["src/server/**/*.spec.ts"],
		});

		expect(() =>
			filterProjectsByFiles([client, server], ["src/shared/foo.spec.ts"], "/repo"),
		).toThrow(/src\/shared\/foo\.spec\.ts[\s\S]*src\/client[\s\S]*src\/server/);
	});

	it("should skip projects whose includes have no static root and still throw on overall no-match", () => {
		expect.assertions(1);

		const wildcard = makeProject({
			displayName: "wildcard",
			include: ["**/*.spec.ts"],
		});

		expect(() => filterProjectsByFiles([wildcard], ["src/foo.spec.ts"], "/repo")).toThrow(
			/no project/i,
		);
	});
});
