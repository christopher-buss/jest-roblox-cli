import { fromAny } from "@total-typescript/shoehorn";

import { assert, describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { ConfigError } from "../config/errors.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import { deriveCoverageFromIncludes } from "../coverage-pipeline/derive-coverage-from.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { ImplicitProjectSeams } from "./single-projects.ts";
import { buildImplicitProject, deriveProjectMounts } from "./single-projects.ts";

const tree: RojoTreeNode = fromAny({
	$className: "DataModel",
	ReplicatedStorage: { Shared: { $path: "out/shared" } },
	ServerScriptService: { Server: { $path: "out/server" } },
});

function emptySeams(): ImplicitProjectSeams {
	return { fileSystem: createMemoryFileSystem().fileSystem, tsconfigReader: () => null };
}

function captureConfigError(action: () => void): ConfigError {
	let captured: unknown;
	try {
		action();
	} catch (err) {
		captured = err;
	}

	assert(captured instanceof ConfigError);
	return captured;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return fromAny({
		luauRoots: ["out/shared"],
		rootDir: "/pkg",
		testMatch: ["**/*.spec.ts", "**/*.spec.tsx"],
		...overrides,
	});
}

describe(deriveProjectMounts, () => {
	it("should map each luau root to its Rojo mount", () => {
		expect.assertions(1);

		expect(
			deriveProjectMounts(["out/shared", "out/server"].map(toPosixRoot), tree),
		).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
			{ dataModelPath: "ServerScriptService/Server", fsPath: "out/server" },
		]);
	});

	it("should skip luau roots that do not map to the rojo tree", () => {
		expect.assertions(1);

		expect(
			deriveProjectMounts(["out/shared", "out/missing"].map(toPosixRoot), tree),
		).toStrictEqual([{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" }]);
	});

	it("should dedupe roots that resolve to the same DataModel path", () => {
		expect.assertions(1);

		expect(
			deriveProjectMounts(["out/shared", "out/shared"].map(toPosixRoot), tree),
		).toStrictEqual([{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" }]);
	});
});

describe(buildImplicitProject, () => {
	it("should build one project from the mapped luau roots", () => {
		expect.assertions(2);

		const config = makeConfig({ displayName: "shared" });
		const { config: projectConfig, ...rest } = buildImplicitProject(config, tree, emptySeams());

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

		const project = buildImplicitProject(
			makeConfig({ testMatch: DEFAULT_CONFIG.testMatch }),
			tree,
			emptySeams(),
		);

		expect(project.include).not.toContain("**/*.spec-d.ts");
		expect(project.include).not.toContain("**/*.test-d.ts");
		// `deriveCoverageFromIncludes` runs `inferSourceExtension` on every
		// include entry; a leaked `-d` glob has no `.spec`/`.test` source
		// extension and throws, crashing a `--coverage` run. Guards that.
		expect(() => deriveCoverageFromIncludes([project])).not.toThrow();
	});

	it("should qualify a bare testMatch glob with **/ so it matches at any depth", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject(makeConfig({ testMatch: ["*.spec.ts"] }), tree, emptySeams())
				.testMatch,
		).toStrictEqual(["**/*.spec"]);
	});

	it("should forward the config's exclude globs", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject(makeConfig({ exclude: ["**/*.gen.spec.ts"] }), tree, emptySeams())
				.exclude,
		).toStrictEqual(["**/*.gen.spec.ts"]);
	});

	it("should leave outDir undefined when the project spans multiple mounts", () => {
		expect.assertions(2);

		const project = buildImplicitProject(
			makeConfig({ displayName: "all", luauRoots: ["out/shared", "out/server"] }),
			tree,
			emptySeams(),
		);

		expect(project.outDir).toBeUndefined();
		expect(project.projects).toStrictEqual([
			"ReplicatedStorage/Shared",
			"ServerScriptService/Server",
		]);
	});

	it("should derive displayName from rootDir when none is configured", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject(makeConfig({ rootDir: "/path/to/my-pkg/" }), tree, emptySeams())
				.displayName,
		).toBe("my-pkg");
	});

	it("should fall back to rootDir for an empty-string displayName", () => {
		expect.assertions(1);

		expect(
			buildImplicitProject(
				makeConfig({ displayName: "", rootDir: "/x/pkg" }),
				tree,
				emptySeams(),
			).displayName,
		).toBe("pkg");
	});

	it("should carry the name and color from a DisplayName object", () => {
		expect.assertions(2);

		const project = buildImplicitProject(
			makeConfig({ displayName: { name: "tinted", color: "magenta" } }),
			tree,
			emptySeams(),
		);

		expect(project.displayName).toBe("tinted");
		expect(project.displayColor).toBe("magenta");
	});

	it("should throw a ConfigError when no luau root maps to the rojo tree", () => {
		expect.assertions(2);

		const error = captureConfigError(() => {
			buildImplicitProject(makeConfig({ luauRoots: ["out/missing"] }), tree, emptySeams());
		});

		expect(error.message).toBe(
			"No test projects could be derived: none of the resolved luauRoots map to a $path mount in your Rojo project.",
		);
		expect(error.hint).toBe(
			'Set "projects" in your test config (e.g. ["ReplicatedStorage/shared"]), or point "luauRoots" at a compiled-output directory your Rojo project mounts.',
		);
	});

	// `--typecheckOnly` is host-local tsgo, so the collapse hands over no Rojo
	it("should build a project with no mounts when no rojo tree is supplied", () => {
		expect.assertions(3);

		const project = buildImplicitProject(
			fromAny({ rootDir: "/pkg", testMatch: ["**/*.spec.ts"] }),
			undefined,
			emptySeams(),
		);

		expect(project.rojoMounts).toStrictEqual([]);
		expect(project.projects).toStrictEqual([]);
		expect(project.outDir).toBeUndefined();
	});

	it("should not throw the no-mounts ConfigError when no rojo tree is supplied", () => {
		expect.assertions(1);

		expect(() => buildImplicitProject(makeConfig(), undefined, emptySeams())).not.toThrow();
	});

	// `include` strips `-d` globs and the multi pipeline derives Type Tests from
	// `include`, so a `testMatch` of only `-d` globs would otherwise discover
	// nothing.
	it("should seed typecheck.include from the -d globs in testMatch", () => {
		expect.assertions(1);

		const project = buildImplicitProject(
			makeConfig({ testMatch: ["**/*.spec.ts", "**/*.spec-d.ts", "**/*.test-d.ts"] }),
			undefined,
			emptySeams(),
		);

		expect(project.typecheck!.include).toStrictEqual(["**/*.spec-d.ts", "**/*.test-d.ts"]);
	});

	it("should keep an explicit typecheck.include over the derived -d globs", () => {
		expect.assertions(1);

		const project = buildImplicitProject(
			makeConfig({
				testMatch: ["**/*.spec.ts", "**/*.spec-d.ts"],
				typecheck: { enabled: true, include: ["types/**/*.spec-d.ts"] },
			}),
			undefined,
			emptySeams(),
		);

		expect(project.typecheck).toStrictEqual({
			enabled: true,
			include: ["types/**/*.spec-d.ts"],
		});
	});

	it("should leave typecheck unset when testMatch carries no -d globs", () => {
		expect.assertions(1);

		expect(buildImplicitProject(makeConfig(), tree, emptySeams()).typecheck).toBeUndefined();
	});
});
