// cspell:words includ
import type { PathClassifier, PathKind } from "@isentinel/rojo-utils";
import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import { ConfigError } from "./errors.ts";
import {
	createFsClassifier,
	extractProjectRoots,
	extractStaticRoot,
	loadProjectConfigFile,
	mapFsRootToDataModel,
	resolveAllProjects,
	resolveProjectConfig,
	stripTsExtension,
	validateProjects,
} from "./projects.ts";
import { DEFAULT_CONFIG } from "./schema.ts";
import type { ProjectTestConfig, ResolvedConfig } from "./schema.ts";

function allDirectories(): PathKind {
	return "directory";
}

function makeClassifier(kinds: Record<string, PathKind>): PathClassifier {
	function classify(fsPath: string): PathKind {
		return kinds[fsPath] ?? "missing";
	}

	return classify;
}

vi.mock<typeof import("c12")>(import("c12"), async (importOriginal) => {
	const actual = await importOriginal();

	return {
		...actual,
		loadConfig: fromAny(vi.fn<(options: LoadConfigOptions) => Promise<C12ResolvedConfig>>()),
	};
});

vi.mock<typeof import("../executor.ts")>(import("../executor.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		resolveTsconfigDirectories: vi
			.fn<typeof actual.resolveTsconfigDirectories>()
			.mockReturnValue({ outDir: "out", rootDir: "src" }),
	};
});

vi.mock<typeof import("./luau-config-loader.ts")>(
	import("./luau-config-loader.ts"),
	async (importOriginal) => {
		const actual = await importOriginal();
		return {
			...actual,
			findLuauConfigFile: vi.fn<typeof actual.findLuauConfigFile>(),
			loadLuauConfig: vi.fn<typeof actual.loadLuauConfig>(),
		};
	},
);

const simpleRojoTree: RojoTreeNode = {
	$className: "DataModel",
	ReplicatedStorage: {
		client: { $path: "out/client" },
	},
	ServerScriptService: {
		server: { $path: "out/server" },
	},
};

function makeProject(overrides: Partial<ProjectTestConfig> = {}): ProjectTestConfig {
	return {
		displayName: "test-project",
		include: ["src/client/**/*.spec.ts"],
		...overrides,
	};
}

describe(extractStaticRoot, () => {
	it("should split at first glob character *", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/client/**/*.spec.ts");

		expect(result.root).toBe("src/client");
		expect(result.glob).toBe("**/*.spec.ts");
	});

	it("should split at first glob character ?", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/client/foo?.spec.ts");

		expect(result.root).toBe("src/client");
		expect(result.glob).toBe("foo?.spec.ts");
	});

	it("should split at first glob character {", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/{a,b}/*.spec.ts");

		expect(result.root).toBe("src");
		expect(result.glob).toBe("{a,b}/*.spec.ts");
	});

	it("should split at first glob character [", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/[abc]/*.spec.ts");

		expect(result.root).toBe("src");
		expect(result.glob).toBe("[abc]/*.spec.ts");
	});

	it("should throw when pattern has no static directory prefix", () => {
		expect.assertions(1);

		expect(() => extractStaticRoot("**/*.spec.ts")).toThrow(
			"Include pattern must have a static directory prefix",
		);
	});

	it("should throw when glob starts immediately with no slash", () => {
		expect.assertions(1);

		expect(() => extractStaticRoot("*.spec.ts")).toThrow(
			"Include pattern must have a static directory prefix",
		);
	});

	it("should handle pattern with no glob characters", () => {
		expect.assertions(2);

		const result = extractStaticRoot("src/client/foo.spec.ts");

		expect(result.root).toBe("src/client");
		expect(result.glob).toBe("foo.spec.ts");
	});

	it("should handle a filename-only pattern with no glob characters", () => {
		expect.assertions(1);

		expect(extractStaticRoot("foo.spec.ts")).toStrictEqual({
			glob: "foo.spec.ts",
			root: ".",
		});
	});
});

describe(stripTsExtension, () => {
	it("should strip .ts extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec.ts")).toBe("**/*.spec");
	});

	it("should strip .tsx extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.test.tsx")).toBe("**/*.test");
	});

	it("should strip .lua extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec.lua")).toBe("**/*.spec");
	});

	it("should strip .luau extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec.luau")).toBe("**/*.spec");
	});

	it("should not change pattern without known extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec")).toBe("**/*.spec");
	});

	it("should not change pattern with .js extension", () => {
		expect.assertions(1);

		expect(stripTsExtension("**/*.spec.js")).toBe("**/*.spec.js");
	});
});

describe(extractProjectRoots, () => {
	it("should extract single root with single pattern", () => {
		expect.assertions(1);

		const result = extractProjectRoots(["src/client/**/*.spec.ts"]);

		expect(result).toStrictEqual([{ root: "src/client", testMatch: ["**/*.spec"] }]);
	});

	it("should group multiple patterns under same root", () => {
		expect.assertions(1);

		const result = extractProjectRoots(["src/client/**/*.spec.ts", "src/client/**/*.test.ts"]);

		expect(result).toStrictEqual([
			{ root: "src/client", testMatch: ["**/*.spec", "**/*.test"] },
		]);
	});

	it("should separate different roots", () => {
		expect.assertions(2);

		const result = extractProjectRoots(["src/client/**/*.spec.ts", "src/server/**/*.spec.ts"]);

		expect(result).toHaveLength(2);
		expect(result).toStrictEqual([
			{ root: "src/client", testMatch: ["**/*.spec"] },
			{ root: "src/server", testMatch: ["**/*.spec"] },
		]);
	});

	it("should prepend **/ to testMatch without path separator", () => {
		expect.assertions(1);

		const result = extractProjectRoots(["src/*.spec.ts"]);

		expect(result).toStrictEqual([{ root: "src", testMatch: ["**/*.spec"] }]);
	});

	it("should not prepend **/ to testMatch with path separator", () => {
		expect.assertions(1);

		const result = extractProjectRoots(["src/**/*.spec.ts"]);

		expect(result).toStrictEqual([{ root: "src", testMatch: ["**/*.spec"] }]);
	});

	it("should handle mixed roots and patterns", () => {
		expect.assertions(1);

		const result = extractProjectRoots([
			"src/client/**/*.spec.ts",
			"src/client/**/*.test.tsx",
			"src/server/**/*.spec.ts",
		]);

		expect(result).toStrictEqual([
			{ root: "src/client", testMatch: ["**/*.spec", "**/*.test"] },
			{ root: "src/server", testMatch: ["**/*.spec"] },
		]);
	});
});

describe(mapFsRootToDataModel, () => {
	it("should map outDir to DataModel path via Rojo tree", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel(toPosixRoot("out/client"), simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client");
	});

	it("should map server outDir to DataModel path", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel(toPosixRoot("out/server"), simpleRojoTree);

		expect(result).toBe("ServerScriptService/server");
	});

	it("should handle nested tree structures", () => {
		expect.assertions(1);

		const nestedTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: {
					lib: { $path: "out/shared/lib" },
				},
			},
		};

		const result = mapFsRootToDataModel(toPosixRoot("out/shared/lib"), nestedTree);

		expect(result).toBe("ReplicatedStorage/shared/lib");
	});

	it("should handle path nested under a $path entry", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel(toPosixRoot("out/client/ui"), simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client/ui");
	});

	it("should throw ConfigError when no mapping found", () => {
		expect.assertions(2);

		expect(() => mapFsRootToDataModel(toPosixRoot("out/unknown"), simpleRojoTree)).toThrow(
			ConfigError,
		);
		expect(() => mapFsRootToDataModel(toPosixRoot("out/unknown"), simpleRojoTree)).toThrow(
			/No Rojo tree mapping found for path: out\/unknown\n\nAvailable \$path entries: out\/client, out\/server/,
		);
	});

	it("should include hint when path starts with src/", () => {
		expect.assertions(1);

		let caught: unknown;
		try {
			mapFsRootToDataModel(toPosixRoot("src/client"), simpleRojoTree);
		} catch (err) {
			caught = err;
		}

		assert(caught instanceof ConfigError);

		expect(caught.hint).toMatch(/set "outDir"/);
	});

	it("should omit hint when path does not start with src/", () => {
		expect.assertions(1);

		let caught: unknown;
		try {
			mapFsRootToDataModel(toPosixRoot("out/unknown"), simpleRojoTree);
		} catch (err) {
			caught = err;
		}

		assert(caught instanceof ConfigError);

		expect(caught.hint).toBeUndefined();
	});

	it("should omit available paths line when tree has no $path entries", () => {
		expect.assertions(1);

		const emptyTree: RojoTreeNode = { $className: "DataModel" };

		expect(() => {
			mapFsRootToDataModel(toPosixRoot("out/foo"), emptyTree);
		}).toThrowWithMessage(Error, "No Rojo tree mapping found for path: out/foo");
	});

	it("should strip trailing slash before lookup", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel(toPosixRoot("out/client/"), simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client");
	});

	it("should look up source path directly for pure Luau", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: { $path: "shared" },
			},
		};

		const result = mapFsRootToDataModel(toPosixRoot("shared"), tree);

		expect(result).toBe("ReplicatedStorage/shared");
	});
});

describe(validateProjects, () => {
	it("should accept valid projects", () => {
		expect.assertions(1);

		expect(() => {
			validateProjects([
				makeProject({ displayName: "client" }),
				makeProject({ displayName: "server" }),
			]);
		}).not.toThrow();
	});

	it("should throw on empty displayName string", () => {
		expect.assertions(1);

		expect(() => {
			validateProjects([makeProject({ displayName: "" })]);
		}).toThrow("Project must have a non-empty displayName");
	});

	it("should throw on empty displayName object", () => {
		expect.assertions(1);

		expect(() => {
			validateProjects([makeProject({ displayName: { name: "", color: "blue" } })]);
		}).toThrow("Project must have a non-empty displayName");
	});

	it("should throw on duplicate displayName", () => {
		expect.assertions(1);

		expect(() => {
			validateProjects([
				makeProject({ displayName: "client" }),
				makeProject({ displayName: "client" }),
			]);
		}).toThrow("Duplicate project displayName: client");
	});

	it("should throw on empty include array", () => {
		expect.assertions(1);

		expect(() => {
			validateProjects([makeProject({ displayName: "client", include: [] })]);
		}).toThrow('Project "client" must have at least one include pattern');
	});

	it("should throw when include was never derived", () => {
		expect.assertions(1);

		expect(() => {
			validateProjects([{ displayName: "client" }]);
		}).toThrow('Project "client" must have at least one include pattern');
	});
});

describe(resolveProjectConfig, () => {
	const rootConfig: ResolvedConfig = {
		...DEFAULT_CONFIG,
		rootDir: "/project",
		silent: false,
		verbose: true,
	};

	it("should resolve DataModel path from outDir", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.projects).toStrictEqual(["ReplicatedStorage/client"]);
	});

	it("should fall back to static root from include when outDir is not set", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: { $path: "src/shared" },
			},
		};

		const project = makeProject({
			displayName: "shared",
			include: ["src/shared/**/*.spec.luau"],
		});

		const result = resolveProjectConfig(project, rootConfig, tree, allDirectories);

		expect(result.projects).toStrictEqual(["ReplicatedStorage/shared"]);
	});

	it("should combine root and outDir for DataModel lookup", () => {
		expect.assertions(1);

		const rojoTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "packages/core/out/client" },
			},
		};

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
			root: "packages/core",
		});

		const result = resolveProjectConfig(project, rootConfig, rojoTree, allDirectories);

		expect(result.projects).toStrictEqual(["ReplicatedStorage/client"]);
	});

	it("should store resolved outDir on result", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.outDir).toBe("out/client");
	});

	it("should store resolved outDir with root prefix", () => {
		expect.assertions(1);

		const rojoTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "packages/core/out/client" },
			},
		};

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
			root: "packages/core",
		});

		const result = resolveProjectConfig(project, rootConfig, rojoTree, allDirectories);

		expect(result.outDir).toBe("packages/core/out/client");
	});

	it("should extract testMatch from include patterns with stripped extensions", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts", "src/client/**/*.test.tsx"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
	});

	it("should inherit non-ROOT_ONLY fields from root config", () => {
		expect.assertions(2);

		const project = makeProject({ displayName: "client", outDir: "out/client" });

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.config.verbose).toBeTrue();
		expect(result.config.silent).toBeFalse();
	});

	it("should keep ROOT_ONLY keys from root config", () => {
		expect.assertions(2);

		const project = makeProject({ displayName: "client", outDir: "out/client" });

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.config.backend).toBe(rootConfig.backend);
		expect(result.config.rootDir).toBe(rootConfig.rootDir);
	});

	it("should allow project to override non-ROOT_ONLY fields", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			outDir: "out/client",
			testTimeout: 5000,
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.config.testTimeout).toBe(5000);
	});

	it("should keep every project-structural field out of the runtime config", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			exclude: ["src/client/generated/**"],
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
			root: ".",
			typecheck: { enabled: true },
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect({
			displayName: Reflect.get(result.config, "displayName"),
			exclude: Reflect.get(result.config, "exclude"),
			include: Reflect.get(result.config, "include"),
			outDir: Reflect.get(result.config, "outDir"),
			root: Reflect.get(result.config, "root"),
			typecheck: Reflect.get(result.config, "typecheck"),
		}).toStrictEqual({
			displayName: undefined,
			exclude: undefined,
			include: undefined,
			outDir: undefined,
			root: undefined,
			typecheck: undefined,
		});
	});

	it("should skip undefined project override values", () => {
		expect.assertions(1);

		// `testTimeout: undefined` cannot be expressed under
		// exactOptionalPropertyTypes, but a hand-written config can still
		// deliver it at runtime — which is the path under test.
		const project: ProjectTestConfig = fromAny({
			...makeProject({ displayName: "client", outDir: "out/client" }),
			testTimeout: undefined,
		});

		const result = resolveProjectConfig(
			project,
			{ ...rootConfig, testTimeout: 12_345 },
			simpleRojoTree,
			allDirectories,
		);

		expect(result.config.testTimeout).toBe(12_345);
	});

	it("should extract displayName string from DisplayName object", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: { name: "client-tests", color: "cyan" },
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.displayName).toBe("client-tests");
	});

	it("should prepend root to resolved include patterns for filesystem discovery", () => {
		expect.assertions(1);

		const rojoTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "packages/core/out/client" },
			},
		};

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
			root: "packages/core",
		});

		const result = resolveProjectConfig(project, rootConfig, rojoTree, allDirectories);

		expect(result.include).toStrictEqual(["packages/core/src/client/**/*.spec.ts"]);
	});

	it("should prepend root to resolved exclude patterns for filesystem discovery", () => {
		expect.assertions(1);

		const rojoTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "packages/core/out/client" },
			},
		};

		const project = makeProject({
			displayName: "client",
			exclude: ["src/client/**/*.gen.spec.ts"],
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
			root: "packages/core",
		});

		const result = resolveProjectConfig(project, rootConfig, rojoTree, allDirectories);

		expect(result.exclude).toStrictEqual(["packages/core/src/client/**/*.gen.spec.ts"]);
	});

	it("should return empty projects when no outDir and no include roots", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "empty",
			include: [],
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.projects).toBeEmpty();
	});

	it("should populate rojoMounts with a single mount when outDir is set", () => {
		expect.assertions(2);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
		expect(result.outDir).toBe("out/client");
	});

	it("should auto-expand multi-root includes via tree walk", () => {
		expect.assertions(4);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "src/Client" },
				Shared: { $path: "src/Shared" },
			},
			ServerScriptService: {
				Server: { $path: "src/Server" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "friends",
			include: ["src/**/*.spec.luau"],
		});

		const result = resolveProjectConfig(project, rootConfig, tree, allDirectories);

		expect(result.projects).toStrictEqual([
			"ReplicatedStorage/Client",
			"ReplicatedStorage/Shared",
			"ServerScriptService/Server",
		]);
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Client", fsPath: "src/Client" },
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "src/Shared" },
			{ dataModelPath: "ServerScriptService/Server", fsPath: "src/Server" },
		]);
		expect(result.outDir).toBeUndefined();
		expect(result.exclude).toStrictEqual([]);
	});

	it("should respect segment boundaries during auto-expand", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "src/Client" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "cli-only",
			// src/Cli must NOT match $path src/Client.
			include: ["src/Cli/**/*.spec.luau"],
		});

		expect(() => {
			return resolveProjectConfig(project, rootConfig, tree, allDirectories);
		}).toThrowWithMessage(
			ConfigError,
			/include root "src\/Cli" did not match any Rojo \$path entry/,
		);
	});

	it("should skip file-valued $path entries during auto-expand", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Constants: { $path: "src/shared/Constants.luau" },
				shared: { $path: "src/shared" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "shared",
			include: ["src/shared/**/*.spec.luau"],
		});

		const classify = makeClassifier({
			"src/shared": "directory",
			"src/shared/Constants.luau": "file",
		});

		const result = resolveProjectConfig(project, rootConfig, tree, classify);

		// The file-valued Constants.luau is not eligible; the exact-lookup
		// match on src/shared wins.
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/shared", fsPath: "src/shared" },
		]);
	});

	it("should skip missing paths during auto-expand without throwing", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "src/Client" },
				Stale: { $path: "src/Stale" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "partial",
			include: ["src/**/*.spec.luau"],
		});

		const classify = makeClassifier({
			"src/Client": "directory",
		});

		const result = resolveProjectConfig(project, rootConfig, tree, classify);

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Client", fsPath: "src/Client" },
		]);
	});

	it("should prune descendant mounts when ancestor is present", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: {
					$path: "src/Client",
					Systems: { $path: "src/Client/Systems" },
				},
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "client",
			include: ["src/Client/**/*.spec.luau"],
		});

		const result = resolveProjectConfig(project, rootConfig, tree, allDirectories);

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Client", fsPath: "src/Client" },
		]);
	});

	it("should dedupe mounts when two include roots expand to the same mount", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Shared: { $path: "src/Shared" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "shared",
			// Both roots expand to the same mount under src/Shared.
			include: ["src/**/*.spec.luau", "src/Shared/**/*.test.luau"],
		});

		const result = resolveProjectConfig(project, rootConfig, tree, allDirectories);

		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/Shared", fsPath: "src/Shared" },
		]);
	});

	it("should produce deterministic order across roots that expand to disjoint mounts", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				A: { $path: "src/a" },
				B: { $path: "src/b" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "ordered",
			include: ["src/a/**/*.spec.luau", "src/b/**/*.spec.luau"],
		});

		const result = resolveProjectConfig(project, rootConfig, tree, allDirectories);

		expect(result.projects).toStrictEqual(["ReplicatedStorage/A", "ReplicatedStorage/B"]);
	});

	it("should use exact lookup when outDir is set even with multiple include roots", () => {
		expect.assertions(2);

		const project = makeProject({
			displayName: "pinned",
			include: ["src/client/**/*.spec.ts", "src/server/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.rojoMounts).toHaveLength(1);
		expect(result.rojoMounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
	});

	it("should throw when outDir is set but maps to no DataModel path", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "bad-outdir",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/nonexistent",
		});

		expect(() => {
			return resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);
		}).toThrowWithMessage(ConfigError, /No Rojo tree mapping found for path: out\/nonexistent/);
	});

	it("should apply project root before extracting include roots", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "packages/friends/src/Client" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "friends",
			include: ["src/Client/**/*.spec.luau"],
			root: "packages/friends",
		});

		const result = resolveProjectConfig(project, rootConfig, tree, allDirectories);

		expect(result.rojoMounts).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/Client",
				fsPath: "packages/friends/src/Client",
			},
		]);
	});

	it("should throw with nearby $path suggestions when include root is unmappable", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "out/Client" },
				Shared: { $path: "out/Shared" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "lost",
			include: ["ghost/**/*.spec.luau"],
		});

		expect(() => {
			return resolveProjectConfig(project, rootConfig, tree, allDirectories);
		}).toThrowWithMessage(ConfigError, /Available \$path entries: out\/Client, out\/Shared/);
	});

	it("should omit available-entries line when rojo tree has no $path entries", () => {
		expect.assertions(1);

		const emptyTree = { $className: "DataModel" } satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "lost",
			include: ["ghost/**/*.spec.luau"],
		});

		expect(() => {
			resolveProjectConfig(project, rootConfig, emptyTree, allDirectories);
		}).not.toThrow(/Available \$path entries/);
	});

	it("should hint about outDir when unmappable root starts with src/", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Client: { $path: "out/client" },
			},
		} satisfies RojoTreeNode;

		const project = makeProject({
			displayName: "hint-me",
			include: ["src/ghost/**/*.spec.ts"],
		});

		let caught: unknown;
		try {
			resolveProjectConfig(project, rootConfig, tree, allDirectories);
		} catch (err) {
			caught = err;
		}

		assert(caught instanceof ConfigError);

		expect(caught.hint).toBe(
			'Path starts with "src/" — if using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")',
		);
	});

	it("should resolve includes from cwd when root is not set", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree, allDirectories);

		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});
});

describe(loadProjectConfigFile, () => {
	it("should load and return project config via c12", async () => {
		expect.assertions(3);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./client.config.ts", "/project");

		expect(result.displayName).toBe("client");
		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
		expect(mockLoadConfig).toHaveBeenCalledExactlyOnceWith({
			name: "jest-project",
			configFile: "./client.config.ts",
			configFileRequired: true,
			cwd: "/project",
			dotenv: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should unwrap project configs exported with defineProject shape", async () => {
		expect.assertions(2);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				test: {
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
				},
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./client.config.ts", "/project");

		expect(result.displayName).toBe("client");
		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});

	it("should throw when config file not found", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockRejectedValueOnce(new Error("File not found"));

		await expect(loadProjectConfigFile("./missing.config.ts", "/project")).rejects.toThrow(
			"Failed to load project config file ./missing.config.ts: File not found",
		);
	});

	it("should stringify non-Error thrown values", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockRejectedValueOnce("raw string rejection");

		await expect(loadProjectConfigFile("./bad.config.ts", "/project")).rejects.toThrow(
			"Failed to load project config file ./bad.config.ts: raw string rejection",
		);
	});

	it("should preserve original error message for non-ENOENT errors", async () => {
		expect.assertions(3);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		const cause = new Error("Syntax error in config");
		mockLoadConfig.mockRejectedValueOnce(cause);

		const promise = loadProjectConfigFile("./broken.config.ts", "/project");

		await expect(promise).rejects.toThrow(
			"Failed to load project config file ./broken.config.ts: Syntax error in config",
		);
		await expect(promise).rejects.toHaveProperty("cause", cause);
		expect(mockLoadConfig).toHaveBeenCalledOnce();
	});

	it("should extract displayName from object-style displayName", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: { name: "client", color: "cyan" },
				include: ["src/client/**/*.spec.ts"],
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./client.config.ts", "/project");

		expect(result.displayName).toStrictEqual({ name: "client", color: "cyan" });
	});

	it("should throw when config has no displayName", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "",
				include: ["src/**/*.spec.ts"],
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(loadProjectConfigFile("./no-name.config.ts", "/project")).rejects.toThrow(
			'Project config file "./no-name.config.ts" must have a displayName',
		);
	});

	it("should throw when config omits displayName entirely", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: { include: ["src/**/*.spec.ts"] },
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(loadProjectConfigFile("./no-name.config.ts", "/project")).rejects.toThrow(
			/Invalid project config file "\.\/no-name\.config\.ts"/,
		);
	});

	it("should reject an unknown key in a project config file", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: { displayName: "client", includ: ["src/**/*.spec.ts"] },
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(loadProjectConfigFile("./typo.config.ts", "/project")).rejects.toThrow(
			/Invalid project config file "\.\/typo\.config\.ts".*includ/,
		);
	});

	it("should derive include from testMatch when include is missing", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "shared",
				testMatch: ["**/__tests__/**/*.test"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./shared/jest.config.ts", "/project");

		expect(result.include).toStrictEqual([
			"shared/**/__tests__/**/*.test.ts",
			"shared/**/__tests__/**/*.test.tsx",
		]);
	});

	it("should leave include undefined when neither include nor testMatch is set", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "minimal",
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./minimal.config.ts", "/project");

		expect(result).not.toHaveProperty("include");
	});

	it("should derive outDir from config path for roblox-ts projects", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "shared",
				testMatch: ["**/__tests__/**/*.test"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("src/shared/jest.config.ts", "/project");

		expect(result.outDir).toBe("out/shared");
	});

	it("should not derive outDir when tsconfig has no rootDir/outDir", async () => {
		expect.assertions(1);

		const { resolveTsconfigDirectories } = await import("../executor.ts");
		vi.mocked(resolveTsconfigDirectories).mockReturnValueOnce({
			outDir: undefined,
			rootDir: undefined,
		});

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "luau-only",
				testMatch: ["**/*.spec"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("src/shared/jest.config.ts", "/project");

		expect(result.outDir).toBeUndefined();
	});

	it.for([
		{ outDir: "out", rootDir: undefined },
		{ outDir: undefined, rootDir: "src" },
	])(
		"should not derive outDir when only one tsconfig directory is available",
		async (directories) => {
			expect.assertions(1);

			const { resolveTsconfigDirectories } = await import("../executor.ts");
			vi.mocked(resolveTsconfigDirectories).mockReturnValueOnce(directories);

			const { loadConfig } = await import("c12");
			vi.mocked(loadConfig).mockResolvedValueOnce({
				config: { displayName: "partial", testMatch: ["**/*.spec"] },
				configFile: "jest.config.ts",
				cwd: "/project",
				layers: [],
			});

			const result = await loadProjectConfigFile("src/shared/jest.config.ts", "/project");

			expect(result).not.toHaveProperty("outDir");
		},
	);

	it("should preserve an explicit outDir when tsconfig directories are available", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		vi.mocked(loadConfig).mockResolvedValueOnce({
			config: { displayName: "custom", outDir: "custom-output", testMatch: ["**/*.spec"] },
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("src/shared/jest.config.ts", "/project");

		expect(result.outDir).toBe("custom-output");
	});

	it("should not derive outDir when config path is not under src/", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "lib",
				testMatch: ["**/*.spec"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("packages/lib/jest.config.ts", "/project");

		expect(result.outDir).toBeUndefined();
	});

	it("should keep testMatch patterns that already have source extensions", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "mixed",
				testMatch: ["**/*.spec.ts", "**/*.test"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./shared/mixed.config.ts", "/project");

		expect(result.include).toStrictEqual([
			"shared/**/*.spec.ts",
			"shared/**/*.test.ts",
			"shared/**/*.test.tsx",
		]);
	});

	it("should keep Lua and Luau testMatch extensions without adding TypeScript variants", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "luau",
				testMatch: ["**/*.spec.lua", "**/*.test.luau"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./shared/luau.config.ts", "/project");

		expect(result.include).toStrictEqual(["shared/**/*.spec.lua", "shared/**/*.test.luau"]);
	});

	it("should only recognize source extensions at the end of a testMatch pattern", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "suffix",
				testMatch: ["**/*.spec.ts.fixture"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./shared/suffix.config.ts", "/project");

		expect(result.include).toStrictEqual([
			"shared/**/*.spec.ts.fixture.ts",
			"shared/**/*.spec.ts.fixture.tsx",
		]);
	});

	it("should not override include when already provided", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
				testMatch: ["**/*.spec"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile("./client.config.ts", "/project");

		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});

	it("should load Luau config when jest.config.luau exists", async () => {
		expect.assertions(2);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce(
			"/project/packages/shared/jest.config.luau",
		);
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			displayName: "shared-luau",
			testMatch: ["**/*.spec"],
		});

		const result = await loadProjectConfigFile("packages/shared", "/project");

		expect(result.displayName).toBe("shared-luau");
		expect(result.include).toContain("packages/shared/**/*.spec.luau");
	});

	it("should throw when Luau config has empty displayName", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/lib/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({ displayName: "" });

		await expect(loadProjectConfigFile("lib", "/project")).rejects.toThrowWithMessage(
			Error,
			/must have a displayName string/,
		);
	});

	it("should throw when Luau config has no displayName", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/lib/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({});

		await expect(loadProjectConfigFile("lib", "/project")).rejects.toThrowWithMessage(
			Error,
			/must have a displayName string/,
		);
	});

	it("should derive default include pattern when Luau config has no testMatch", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({ displayName: "shared" });

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.include).toStrictEqual(["shared/**/*.spec.luau"]);
	});

	it("should set testMatch on config when Luau config provides testMatch", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			displayName: "shared",
			testMatch: ["**/*.spec", "**/*.test"],
		});

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
	});

	it("should copy boolean optional fields from Luau config", async () => {
		expect.assertions(2);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			clearMocks: true,
			displayName: "shared",
			resetMocks: false,
		});

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.clearMocks).toBeTrue();
		expect(result.resetMocks).toBeFalse();
	});

	it("should copy number optional fields from Luau config", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			displayName: "shared",
			testTimeout: 5000,
		});

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.testTimeout).toBe(5000);
	});

	it("should copy string optional fields from Luau config", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			displayName: "shared",
			testEnvironment: "jest-environment-jsdom",
		});

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.testEnvironment).toBe("jest-environment-jsdom");
	});

	it("should copy string array optional fields from Luau config", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			displayName: "shared",
			setupFiles: ["setup.luau"],
		});

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.setupFiles).toStrictEqual(["setup.luau"]);
	});

	it("should reject fields with wrong types in Luau config", async () => {
		expect.assertions(1);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			clearMocks: "yes",
			displayName: "shared",
			setupFiles: "not-an-array",
			testTimeout: "fast",
		});

		await expect(loadProjectConfigFile("shared", "/project")).rejects.toThrow(
			/clearMocks must be boolean.*setupFiles must be an array.*testTimeout must be a number/s,
		);
	});
});

describe(resolveAllProjects, () => {
	it("should resolve inline project entries", async () => {
		expect.assertions(2);

		const entries = [
			{
				test: makeProject({
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
					outDir: "out/client",
				}),
			},
		];

		const result = await resolveAllProjects(entries, DEFAULT_CONFIG, {
			cwd: "/project",
			rojoTree: simpleRojoTree,
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.displayName).toBe("client");
	});

	it("should load string entries via c12", async () => {
		expect.assertions(2);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "server",
				include: ["src/server/**/*.spec.ts"],
				outDir: "out/server",
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const entries = ["./server.config.ts"];

		const result = await resolveAllProjects(entries, DEFAULT_CONFIG, {
			cwd: "/project",
			rojoTree: simpleRojoTree,
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.displayName).toBe("server");
	});

	it("should handle mixed inline and string entries", async () => {
		expect.assertions(3);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "server",
				include: ["src/server/**/*.spec.ts"],
				outDir: "out/server",
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const entries = [
			{
				test: makeProject({
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
					outDir: "out/client",
				}),
			},
			"./server.config.ts",
		];

		const result = await resolveAllProjects(entries, DEFAULT_CONFIG, {
			cwd: "/project",
			rojoTree: simpleRojoTree,
		});

		expect(result).toHaveLength(2);
		expect(result[0]!.displayName).toBe("client");
		expect(result[1]!.displayName).toBe("server");
	});

	it("should dedupe testMatch when multiple include roots strip to identical patterns", async () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				src: { $path: "src" },
				test: { $path: "test" },
			},
		} satisfies RojoTreeNode;

		const entries = [
			{
				test: makeProject({
					displayName: "shared",
					include: ["src/**/*.spec.luau", "test/**/*.spec.luau"],
				}),
			},
		];

		const result = await resolveAllProjects(entries, DEFAULT_CONFIG, {
			cwd: "/project",
			rojoTree: tree,
		});

		expect(result[0]!.testMatch).toStrictEqual(["**/*.spec"]);
	});

	it("should throw when projects have duplicate names", async () => {
		expect.assertions(1);

		const entries = [
			{
				test: makeProject({
					displayName: "client",
					include: ["src/client/**/*.spec.ts"],
					outDir: "out/client",
				}),
			},
			{
				test: makeProject({
					displayName: "client",
					include: ["src/server/**/*.spec.ts"],
					outDir: "out/server",
				}),
			},
		];

		await expect(
			resolveAllProjects(entries, DEFAULT_CONFIG, {
				cwd: "/project",
				rojoTree: simpleRojoTree,
			}),
		).rejects.toThrow("Duplicate project displayName: client");
	});
});

describe(createFsClassifier, () => {
	it("should return 'directory' for a path holding a directory", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/root/some/directory/child.luau": "" });

		expect(createFsClassifier("/root", fileSystem)("some/directory")).toBe("directory");
	});

	it("should return 'file' for a path holding a file", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/root/some/file.txt": "" });

		expect(createFsClassifier("/root", fileSystem)("some/file.txt")).toBe("file");
	});

	it("should return 'missing' for a path holding nothing", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(createFsClassifier("/root", fileSystem)("missing/path")).toBe("missing");
	});

	it("should resolve relative paths against the given root directory", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/workspace/root/src/Client/init.luau": "",
		});

		expect(createFsClassifier("/workspace/root", fileSystem)("src/Client")).toBe("directory");
	});

	it("should pass absolute paths through without resolution", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/absolute/path/init.luau": "" });

		expect(createFsClassifier("/workspace/root", fileSystem)("/absolute/path")).toBe(
			"directory",
		);
	});
});
