import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import { applyFileFilter } from "./file-filter.ts";
import type { PackageContext } from "./project-contexts.ts";
import { projectKey } from "./project-key.ts";

function makeProject(displayName: string, include: Array<string>): ResolvedProjectConfig {
	return fromAny({ displayName, include });
}

function makeContext(
	name: string,
	packageDirectory: string,
	projects: Array<ResolvedProjectConfig>,
): PackageContext {
	return fromAny({ info: { name, packageDirectory }, projects });
}

function makeWorkspace(): Array<PackageContext> {
	return [
		makeContext("@halcyon/app", "/repo", [
			makeProject("client", ["src/client/**/*.spec.ts"]),
			makeProject("server", ["src/server/**/*.spec.ts"]),
		]),
		makeContext("@halcyon/lib", "/repo/packages/lib", [
			makeProject("lib", ["src/**/*.spec.ts"]),
		]),
	];
}

describe(applyFileFilter, () => {
	const noFilesCases: Array<Array<string> | undefined> = [undefined, []];

	it.for(noFilesCases)("should pass the contexts through untouched for %j", (files) => {
		expect.assertions(2);

		const contexts = makeWorkspace();
		const selection = applyFileFilter({ contexts, cwd: "/repo", files });

		expect(selection.contexts).toBe(contexts);
		expect(selection.filesByProject.size).toBe(0);
	});

	it("should keep only the package and project whose include root owns the file", () => {
		expect.assertions(2);

		const selection = applyFileFilter({
			contexts: makeWorkspace(),
			cwd: "/repo",
			files: ["src/client/a.spec.ts"],
		});

		expect(selection.contexts.map((ctx) => ctx.info.name)).toStrictEqual(["@halcyon/app"]);
		expect(selection.contexts[0]!.projects.map((project) => project.displayName)).toStrictEqual(
			["client"],
		);
	});

	it("should resolve a relative file against the invocation directory, not the package", () => {
		expect.assertions(1);

		const selection = applyFileFilter({
			contexts: makeWorkspace(),
			cwd: "/repo/packages/lib",
			files: ["src/a.spec.ts"],
		});

		expect(selection.contexts.map((ctx) => ctx.info.name)).toStrictEqual(["@halcyon/lib"]);
	});

	it("should record each project's files absolute, keyed by package and project", () => {
		expect.assertions(1);

		const selection = applyFileFilter({
			contexts: makeWorkspace(),
			cwd: "/repo",
			files: ["src/client/a.spec.ts", "packages/lib/src/b.spec.ts"],
		});

		expect([...selection.filesByProject]).toStrictEqual([
			[projectKey("@halcyon/app", "client"), ["/repo/src/client/a.spec.ts"]],
			[projectKey("@halcyon/lib", "lib"), ["/repo/packages/lib/src/b.spec.ts"]],
		]);
	});

	it("should accept an absolute windows path against a posix-shaped root", () => {
		expect.assertions(1);

		const contexts = [
			makeContext("@halcyon/app", "D:/repo", [
				makeProject("client", ["src/client/**/*.spec.ts"]),
			]),
		];

		const selection = applyFileFilter({
			contexts,
			cwd: "D:/repo",
			files: ["D:\\repo\\src\\client\\a.spec.ts"],
		});

		expect([...selection.filesByProject.values()]).toStrictEqual([
			["D:/repo/src/client/a.spec.ts"],
		]);
	});

	it("should report every searched root when no package owns the file", () => {
		expect.assertions(1);

		expect(() => {
			return applyFileFilter({
				contexts: makeWorkspace(),
				cwd: "/repo",
				files: ["src/other/a.spec.ts"],
			});
		}).toThrow(
			"No project contains the requested file(s):\n" +
				"  - src/other/a.spec.ts\n\n" +
				"Project roots searched:\n" +
				"  - /repo/src/client\n" +
				"  - /repo/src/server\n" +
				"  - /repo/packages/lib/src",
		);
	});
});
