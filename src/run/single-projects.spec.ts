import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { configErrorLike } from "#test/mocks/run-config-error.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { BuildImplicitProjectOptions } from "./single-projects.ts";
import { buildImplicitProject } from "./single-projects.ts";

const tree: RojoTreeNode = fromAny({
	$className: "DataModel",
	ReplicatedStorage: { Shared: { $path: "out/shared" } },
	ServerScriptService: { Server: { $path: "out/server" } },
});

function emptySeams(): Pick<BuildImplicitProjectOptions, "fileSystem" | "tsconfigReader"> {
	return { fileSystem: createMemoryFileSystem().fileSystem, tsconfigReader: () => null };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return fromAny({
		luauRoots: ["out/shared"],
		rootDir: "/pkg",
		testMatch: ["**/*.spec.ts", "**/*.spec.tsx"],
		...overrides,
	});
}

function mountsFor(
	luauRoots: Array<string>,
): ReturnType<typeof buildImplicitProject>["rojoMounts"] {
	return buildImplicitProject({
		config: makeConfig({ luauRoots }),
		...emptySeams(),
		rojoTree: tree,
	}).rojoMounts;
}

describe("implicit project mounts", () => {
	it("should map each luau root to its Rojo mount", () => {
		expect.assertions(1);

		expect(mountsFor(["out/shared", "out/server"])).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
			{ dataModelPath: "ServerScriptService/Server", fsPath: "out/server" },
		]);
	});

	it("should skip luau roots that do not map to the rojo tree", () => {
		expect.assertions(1);

		expect(mountsFor(["out/shared", "out/missing"])).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
		]);
	});

	it("should dedupe roots that resolve to the same DataModel path", () => {
		expect.assertions(1);

		expect(mountsFor(["out/shared", "out/shared"])).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
		]);
	});
});

describe(buildImplicitProject, () => {
	it("should build one project from the mapped luau roots", () => {
		expect.assertions(2);

		const config = makeConfig({ displayName: "shared" });
		const { config: projectConfig, ...rest } = buildImplicitProject({
			config,
			...emptySeams(),
			rojoTree: tree,
		});

		expect(projectConfig).toBe(config);
		expect(rest).toStrictEqual({
			displayColor: undefined,
			displayName: "shared",
			exclude: [],
			include: ["**/*.spec.ts", "**/*.spec.tsx"],
			outDir: "out/shared",
			projects: ["ReplicatedStorage/Shared"],
			rojoMounts: [{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" }],
			testMatch: ["**/*.spec"],
			typecheck: undefined,
		});
	});

	it("should exclude type-test (-d) globs from include so a coverage run does not throw", () => {
		expect.assertions(3);

		const project = buildImplicitProject({
			config: makeConfig({ testMatch: createResolvedConfig().testMatch }),
			...emptySeams(),
			rojoTree: tree,
		});

		expect(project.include).not.toContain("**/*.spec-d.ts");
		expect(project.include).not.toContain("**/*.test-d.ts");
		expect(project.include).toStrictEqual([
			"**/*.spec.ts",
			"**/*.spec.tsx",
			"**/*.test.ts",
			"**/*.test.tsx",
			"**/*.spec.lua",
			"**/*.spec.luau",
			"**/*.test.lua",
			"**/*.test.luau",
		]);
	});

	it("should qualify a bare testMatch glob with **/ so it matches at any depth", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject({
				config: makeConfig({ testMatch: ["*.spec.ts"] }),
				...emptySeams(),
				rojoTree: tree,
			}).testMatch,
		).toStrictEqual(["**/*.spec"]);
	});

	it("should forward the config's exclude globs", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject({
				config: makeConfig({ exclude: ["**/*.gen.spec.ts"] }),
				...emptySeams(),
				rojoTree: tree,
			}).exclude,
		).toStrictEqual(["**/*.gen.spec.ts"]);
	});

	it("should leave outDir undefined when the project spans multiple mounts", () => {
		expect.assertions(2);

		const project = buildImplicitProject({
			config: makeConfig({ displayName: "all", luauRoots: ["out/shared", "out/server"] }),
			...emptySeams(),
			rojoTree: tree,
		});

		expect(project.outDir).toBeUndefined();
		expect(project.projects).toStrictEqual([
			"ReplicatedStorage/Shared",
			"ServerScriptService/Server",
		]);
	});

	it("should derive displayName from rootDir when none is configured", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject({
				config: makeConfig({ rootDir: "/path/to/my-pkg/" }),
				...emptySeams(),
				rojoTree: tree,
			}).displayName,
		).toBe("my-pkg");
	});

	it("should fall back to rootDir for an empty-string displayName", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject({
				config: makeConfig({ displayName: "", rootDir: "/x/pkg" }),
				...emptySeams(),
				rojoTree: tree,
			}).displayName,
		).toBe("pkg");
	});

	it("should carry the name and color from a DisplayName object", () => {
		expect.assertions(2);

		const project = buildImplicitProject({
			config: makeConfig({ displayName: { name: "tinted", color: "magenta" } }),
			...emptySeams(),
			rojoTree: tree,
		});

		expect(project.displayName).toBe("tinted");
		expect(project.displayColor).toBe("magenta");
	});

	it("should throw a ConfigError when no luau root maps to the rojo tree", () => {
		expect.assertions(1);

		expect(() => {
			buildImplicitProject({
				config: makeConfig({ luauRoots: ["out/missing"] }),
				...emptySeams(),
				rojoTree: tree,
			});
		}).toThrow(
			configErrorLike(
				"No test projects could be derived: none of the resolved luauRoots map to a $path mount in your Rojo project.",
				'Set "projects" in your test config (e.g. ["ReplicatedStorage/shared"]), or point "luauRoots" at a compiled-output directory your Rojo project mounts.',
			),
		);
	});

	// `--typecheckOnly` is host-local tsgo, so the collapse hands over no Rojo
	it("should build a project with no mounts when no rojo tree is supplied", () => {
		expect.assertions(3);

		const project = buildImplicitProject({
			config: fromAny({ rootDir: "/pkg", testMatch: ["**/*.spec.ts"] }),
			...emptySeams(),
			rojoTree: undefined,
		});

		expect(project.rojoMounts).toStrictEqual([]);
		expect(project.projects).toStrictEqual([]);
		expect(project.outDir).toBeUndefined();
	});

	it("should not throw the no-mounts ConfigError when no rojo tree is supplied", () => {
		expect.assertions(1);

		expect(() => {
			return buildImplicitProject({
				config: makeConfig(),
				...emptySeams(),
				rojoTree: undefined,
			});
		}).not.toThrow();
	});

	// `include` strips `-d` globs and the multi pipeline derives Type Tests from
	// `include`, so a `testMatch` of only `-d` globs would otherwise discover
	// nothing.
	it("should seed typecheck.include from the -d globs in testMatch", () => {
		expect.assertions(1);

		const project = buildImplicitProject({
			config: makeConfig({ testMatch: ["**/*.spec.ts", "**/*.spec-d.ts", "**/*.test-d.ts"] }),
			...emptySeams(),
			rojoTree: undefined,
		});

		expect(project.typecheck!.include).toStrictEqual(["**/*.spec-d.ts", "**/*.test-d.ts"]);
	});

	it("should keep an explicit typecheck.include over the derived -d globs", () => {
		expect.assertions(1);

		const project = buildImplicitProject({
			config: makeConfig({
				testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"],
				typecheck: { enabled: true, include: ["types/**/*.spec-d.ts"] },
			}),
			...emptySeams(),
			rojoTree: undefined,
		});

		expect(project.typecheck).toStrictEqual({
			enabled: true,
			include: ["types/**/*.spec-d.ts"],
		});
	});

	it("should leave typecheck unset when testMatch carries no -d globs", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject({ config: makeConfig(), ...emptySeams(), rojoTree: tree })
				.typecheck,
		).toBeUndefined();
	});
});
