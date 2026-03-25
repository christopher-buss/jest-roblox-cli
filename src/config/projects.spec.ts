import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import { describe, expect, it, vi } from "vitest";

import type { RojoTreeNode } from "../types/rojo.ts";
import { ConfigError } from "./errors.ts";
import {
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

vi.mock<typeof import("c12")>(import("c12"), async (importOriginal) => {
	const actual = await importOriginal();

	return {
		...actual,
		loadConfig: vi.fn<
			(options: LoadConfigOptions) => Promise<C12ResolvedConfig>
		>() as typeof actual.loadConfig,
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

		const result = mapFsRootToDataModel("out/client", simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client");
	});

	it("should map server outDir to DataModel path", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel("out/server", simpleRojoTree);

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

		const result = mapFsRootToDataModel("out/shared/lib", nestedTree);

		expect(result).toBe("ReplicatedStorage/shared/lib");
	});

	it("should handle path nested under a $path entry", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel("out/client/ui", simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client/ui");
	});

	it("should throw ConfigError when no mapping found", () => {
		expect.assertions(2);

		expect(() => mapFsRootToDataModel("out/unknown", simpleRojoTree)).toThrow(ConfigError);
		expect(() => mapFsRootToDataModel("out/unknown", simpleRojoTree)).toThrow(
			/No Rojo tree mapping found for path: out\/unknown\n\nAvailable \$path entries: out\/client, out\/server/,
		);
	});

	it("should include hint when path starts with src/", () => {
		expect.assertions(2);

		let caught: ConfigError | undefined;
		try {
			mapFsRootToDataModel("src/client", simpleRojoTree);
		} catch (err) {
			caught = err as ConfigError;
		}

		expect(caught).toBeInstanceOf(ConfigError);
		expect(caught?.hint).toMatch(/set "outDir"/);
	});

	it("should omit hint when path does not start with src/", () => {
		expect.assertions(2);

		let caught: ConfigError | undefined;
		try {
			mapFsRootToDataModel("out/unknown", simpleRojoTree);
		} catch (err) {
			caught = err as ConfigError;
		}

		expect(caught).toBeInstanceOf(ConfigError);
		expect(caught?.hint).toBeUndefined();
	});

	it("should omit available paths line when tree has no $path entries", () => {
		expect.assertions(1);

		const emptyTree: RojoTreeNode = { $className: "DataModel" };
		let message = "";
		try {
			mapFsRootToDataModel("out/foo", emptyTree);
		} catch (err) {
			({ message } = err as Error);
		}

		expect(message).toBe("No Rojo tree mapping found for path: out/foo");
	});

	it("should strip trailing slash before lookup", () => {
		expect.assertions(1);

		const result = mapFsRootToDataModel("out/client/", simpleRojoTree);

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

		const result = mapFsRootToDataModel("shared", tree);

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

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

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

		const result = resolveProjectConfig(project, rootConfig, tree);

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

		const result = resolveProjectConfig(project, rootConfig, rojoTree);

		expect(result.projects).toStrictEqual(["ReplicatedStorage/client"]);
	});

	it("should store resolved outDir on result", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

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

		const result = resolveProjectConfig(project, rootConfig, rojoTree);

		expect(result.outDir).toBe("packages/core/out/client");
	});

	it("should extract testMatch from include patterns with stripped extensions", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts", "src/client/**/*.test.tsx"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
	});

	it("should inherit non-ROOT_ONLY fields from root config", () => {
		expect.assertions(2);

		const project = makeProject({ displayName: "client", outDir: "out/client" });

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

		expect(result.config.verbose).toBeTrue();
		expect(result.config.silent).toBeFalse();
	});

	it("should keep ROOT_ONLY keys from root config", () => {
		expect.assertions(2);

		const project = makeProject({ displayName: "client", outDir: "out/client" });

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

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

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

		expect(result.config.testTimeout).toBe(5000);
	});

	it("should skip undefined project override values", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			outDir: "out/client",
			testTimeout: undefined,
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

		expect(result.config.testTimeout).toBeUndefined();
	});

	it("should extract displayName string from DisplayName object", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: { name: "client-tests", color: "cyan" },
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

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

		const result = resolveProjectConfig(project, rootConfig, rojoTree);

		expect(result.include).toStrictEqual(["packages/core/src/client/**/*.spec.ts"]);
	});

	it("should return empty projects when no outDir and no include roots", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "empty",
			include: [],
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

		expect(result.projects).toBeEmpty();
	});

	it("should throw when multiple include roots and no outDir", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "multi-root",
			include: ["src/client/**/*.spec.ts", "src/server/**/*.spec.ts"],
		});

		expect(() => resolveProjectConfig(project, rootConfig, simpleRojoTree)).toThrow(
			'Project "multi-root" has multiple include roots but no outDir',
		);
	});

	it("should throw with object displayName when multiple roots and no outDir", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: { name: "multi-root", color: "cyan" },
			include: ["src/client/**/*.spec.ts", "src/server/**/*.spec.ts"],
		});

		expect(() => resolveProjectConfig(project, rootConfig, simpleRojoTree)).toThrowWithMessage(
			Error,
			/Project "multi-root" has multiple include roots but no outDir/,
		);
	});

	it("should resolve includes from cwd when root is not set", () => {
		expect.assertions(1);

		const project = makeProject({
			displayName: "client",
			include: ["src/client/**/*.spec.ts"],
			outDir: "out/client",
		});

		const result = resolveProjectConfig(project, rootConfig, simpleRojoTree);

		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});
});

describe(loadProjectConfigFile, () => {
	it("should load and return project config via c12", async () => {
		expect.assertions(2);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
			} as ProjectTestConfig,
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
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockRejectedValueOnce(new Error("Syntax error in config"));

		await expect(loadProjectConfigFile("./broken.config.ts", "/project")).rejects.toThrow(
			"Failed to load project config file ./broken.config.ts: Syntax error in config",
		);
	});

	it("should extract displayName from object-style displayName", async () => {
		expect.assertions(1);

		const { loadConfig } = await import("c12");
		const mockLoadConfig = vi.mocked(loadConfig);
		mockLoadConfig.mockResolvedValueOnce({
			config: {
				displayName: { name: "client", color: "cyan" },
				include: ["src/client/**/*.spec.ts"],
			} as ProjectTestConfig,
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
			} as ProjectTestConfig,
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(loadProjectConfigFile("./no-name.config.ts", "/project")).rejects.toThrow(
			'Project config file "./no-name.config.ts" must have a displayName',
		);
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

	it("should ignore fields with wrong types in Luau config", async () => {
		expect.assertions(3);

		const { findLuauConfigFile, loadLuauConfig } = await import("./luau-config-loader.ts");
		vi.mocked(findLuauConfigFile).mockReturnValueOnce("/project/shared/jest.config.luau");
		vi.mocked(loadLuauConfig).mockReturnValueOnce({
			clearMocks: "yes" as unknown,
			displayName: "shared",
			setupFiles: "not-an-array" as unknown,
			testTimeout: "fast" as unknown,
		} as Record<string, unknown>);

		const result = await loadProjectConfigFile("shared", "/project");

		expect(result.clearMocks).toBeUndefined();
		expect(result.testTimeout).toBeUndefined();
		expect(result.setupFiles).toBeUndefined();
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

		const result = await resolveAllProjects(
			entries,
			DEFAULT_CONFIG,
			simpleRojoTree,
			"/project",
		);

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
			} as ProjectTestConfig,
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const entries = ["./server.config.ts"];

		const result = await resolveAllProjects(
			entries,
			DEFAULT_CONFIG,
			simpleRojoTree,
			"/project",
		);

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
			} as ProjectTestConfig,
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

		const result = await resolveAllProjects(
			entries,
			DEFAULT_CONFIG,
			simpleRojoTree,
			"/project",
		);

		expect(result).toHaveLength(2);
		expect(result[0]!.displayName).toBe("client");
		expect(result[1]!.displayName).toBe("server");
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
			resolveAllProjects(entries, DEFAULT_CONFIG, simpleRojoTree, "/project"),
		).rejects.toThrow("Duplicate project displayName: client");
	});
});
