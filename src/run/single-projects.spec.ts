import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/errors.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import { deriveCoverageFromIncludes } from "../coverage-pipeline/derive-coverage-from.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { buildImplicitProject, deriveProjectMounts } from "./single-projects.ts";

vi.mock(import("../coverage-pipeline/prepare.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, resolveLuauRoots: vi.fn<typeof actual.resolveLuauRoots>() };
});

const { resolveLuauRoots } = await import("../coverage-pipeline/prepare.ts");

const tree: RojoTreeNode = fromAny({
	$className: "DataModel",
	ReplicatedStorage: { Shared: { $path: "out/shared" } },
	ServerScriptService: { Server: { $path: "out/server" } },
});

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return fromAny({
		rootDir: "/pkg",
		testMatch: ["**/*.spec.ts", "**/*.spec.tsx"],
		...overrides,
	});
}

describe(deriveProjectMounts, () => {
	it("should map each luau root to its Rojo mount", () => {
		expect.assertions(1);

		expect(deriveProjectMounts(["out/shared", "out/server"], tree)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
			{ dataModelPath: "ServerScriptService/Server", fsPath: "out/server" },
		]);
	});

	it("should skip luau roots that do not map to the rojo tree", () => {
		expect.assertions(1);

		expect(deriveProjectMounts(["out/shared", "out/missing"], tree)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
		]);
	});

	it("should dedupe roots that resolve to the same DataModel path", () => {
		expect.assertions(1);

		expect(deriveProjectMounts(["out/shared", "out/shared"], tree)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
		]);
	});

	it("should strip a trailing separator before the rojo lookup", () => {
		expect.assertions(1);

		expect(deriveProjectMounts(["out/shared/"], tree)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "out/shared" },
		]);
	});
});

describe(buildImplicitProject, () => {
	it("should build one project from the mapped luau roots", () => {
		expect.assertions(2);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		const config = makeConfig({ displayName: "shared" });
		const { config: projectConfig, ...rest } = buildImplicitProject(config, tree);

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

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		const project = buildImplicitProject(
			makeConfig({ testMatch: DEFAULT_CONFIG.testMatch }),
			tree,
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

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		expect(
			buildImplicitProject(makeConfig({ testMatch: ["*.spec.ts"] }), tree).testMatch,
		).toStrictEqual(["**/*.spec"]);
	});

	it("should forward the config's exclude globs", () => {
		expect.assertions(1);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		expect(
			buildImplicitProject(makeConfig({ exclude: ["**/*.gen.spec.ts"] }), tree).exclude,
		).toStrictEqual(["**/*.gen.spec.ts"]);
	});

	it("should leave outDir undefined when the project spans multiple mounts", () => {
		expect.assertions(2);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared", "out/server"]);

		const project = buildImplicitProject(makeConfig({ displayName: "all" }), tree);

		expect(project.outDir).toBeUndefined();
		expect(project.projects).toStrictEqual([
			"ReplicatedStorage/Shared",
			"ServerScriptService/Server",
		]);
	});

	it("should derive displayName from rootDir when none is configured", () => {
		expect.assertions(1);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		expect(
			buildImplicitProject(makeConfig({ rootDir: "/path/to/my-pkg/" }), tree).displayName,
		).toBe("my-pkg");
	});

	it("should fall back to rootDir for an empty-string displayName", () => {
		expect.assertions(1);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		expect(
			buildImplicitProject(makeConfig({ displayName: "", rootDir: "/x/pkg" }), tree)
				.displayName,
		).toBe("pkg");
	});

	it("should carry the name and color from a DisplayName object", () => {
		expect.assertions(2);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/shared"]);

		const project = buildImplicitProject(
			makeConfig({ displayName: { name: "tinted", color: "magenta" } }),
			tree,
		);

		expect(project.displayName).toBe("tinted");
		expect(project.displayColor).toBe("magenta");
	});

	it("should throw a ConfigError when no luau root maps to the rojo tree", () => {
		expect.assertions(1);

		vi.mocked(resolveLuauRoots).mockReturnValue(["out/missing"]);

		expect(() => buildImplicitProject(makeConfig(), tree)).toThrow(ConfigError);
	});
});
