import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import * as path from "node:path";
import process from "node:process";
import type { Mock } from "vitest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createConfigFixture } from "#test/mocks/config-fixture.ts";
import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ConfigLoader, ConfigLoadOptions } from "./loader.ts";
import { loadConfig, loadRawConfig, resolveConfig } from "./loader.ts";
import type { Config } from "./schema.ts";

describe(resolveConfig, () => {
	it("should use defaults when no config provided", () => {
		expect.assertions(3);

		const result = resolveConfig({});

		expect(result.testMatch).toStrictEqual(createResolvedConfig().testMatch);
		expect(result.verbose).toBeFalse();
		expect(result.silent).toBeFalse();
	});

	it("should omit artifact paths that the user did not configure", () => {
		expect.assertions(2);

		const result = resolveConfig({});

		expect(result).not.toHaveProperty("gameOutput");
		expect(result).not.toHaveProperty("outputFile");
	});

	it("should override defaults with provided config", () => {
		expect.assertions(2);

		const config: Config = {
			test: {
				testMatch: ["**/*.test.ts"],
				verbose: true,
			},
		};
		const result = resolveConfig(config);

		expect(result.testMatch).toStrictEqual(["**/*.test.ts"]);
		expect(result.verbose).toBeTrue();
	});

	it("should preserve rootDir from config", () => {
		expect.assertions(1);

		const config: Config = {
			rootDir: "/custom/path",
		};
		const result = resolveConfig(config);

		expect(result.rootDir).toBe("/custom/path");
	});

	it("should expand gameOutput: true to game-output.log under rootDir", () => {
		expect.assertions(1);

		const result = resolveConfig({ gameOutput: true, rootDir: "/custom/path" });

		expect(result.gameOutput).toBe(path.join("/custom/path", "game-output.log"));
	});

	it("should leave an explicit gameOutput path untouched", () => {
		expect.assertions(1);

		const result = resolveConfig({ gameOutput: "logs/out.json" });

		expect(result.gameOutput).toBe("logs/out.json");
	});

	it("should expand outputFile: true to jest-output.log under rootDir", () => {
		expect.assertions(1);

		const result = resolveConfig({ outputFile: true, rootDir: "/custom/path" });

		expect(result.outputFile).toBe(path.join("/custom/path", "jest-output.log"));
	});

	it("should leave an explicit outputFile path untouched", () => {
		expect.assertions(1);

		const result = resolveConfig({ outputFile: "results.json" });

		expect(result.outputFile).toBe("results.json");
	});

	it("should accept valid backend values", () => {
		expect.assertions(3);

		expect(resolveConfig({ backend: "auto" }).backend).toBe("auto");
		expect(resolveConfig({ backend: "open-cloud" }).backend).toBe("open-cloud");
		expect(resolveConfig({ backend: "studio" }).backend).toBe("studio");
	});

	it("should throw on invalid backend in config", () => {
		expect.assertions(1);

		const config: Config = fromAny({ backend: "not-a-backend" });

		expect(() => resolveConfig(config)).toThrow("Invalid config");
	});

	it("should default collectCoverage to false", () => {
		expect.assertions(1);

		const result = resolveConfig({});

		expect(result.collectCoverage).toBeFalse();
	});

	it("should default coverageDirectory to 'coverage'", () => {
		expect.assertions(1);

		const result = resolveConfig({});

		expect(result.coverageDirectory).toBe("coverage");
	});

	it("should default coveragePathIgnorePatterns to exclude test and vendor files", () => {
		expect.assertions(1);

		const result = resolveConfig({});

		expect(result.coveragePathIgnorePatterns).toStrictEqual([
			"**/*.spec.lua",
			"**/*.spec.luau",
			"**/*.test.lua",
			"**/*.test.luau",
			"**/node_modules/**",
			"**/rbxts_include/**",
		]);
	});

	it("should default coverageReporters to text and lcov", () => {
		expect.assertions(1);

		const result = resolveConfig({});

		expect(result.coverageReporters).toStrictEqual(["text", "lcov"]);
	});

	it("should leave collectCoverageFrom undefined by default", () => {
		expect.assertions(1);

		const result = resolveConfig({});

		expect(result.collectCoverageFrom).toBeUndefined();
	});

	it("should leave coverageThreshold undefined by default", () => {
		expect.assertions(1);

		const result = resolveConfig({});

		expect(result.coverageThreshold).toBeUndefined();
	});

	it("should override coverageDirectory from config", () => {
		expect.assertions(1);

		const result = resolveConfig({ test: { coverageDirectory: "my-coverage" } });

		expect(result.coverageDirectory).toBe("my-coverage");
	});
});

describe("config loader seams", () => {
	it("should anchor a relative rootDir on the loaded config's package directory", async () => {
		expect.assertions(1);

		const workspaceRoot = path.resolve("/repo");
		const packageDirectory = path.join(workspaceRoot, "packages", "example");
		const configFile = path.join(packageDirectory, "jest.config.mjs");
		const { fileSystem } = createMemoryFileSystem({ [configFile]: "" });
		const configLoader = vi.fn<(options: LoadConfigOptions) => Promise<C12ResolvedConfig>>();
		configLoader.mockResolvedValue({
			config: { rootDir: ".", test: { coverageDirectory: "coverage" } },
			configFile,
			cwd: packageDirectory,
			layers: [],
		});

		const result = await loadConfig({
			configLoader: fromAny(configLoader),
			cwd: workspaceRoot,
			fileSystem,
		});

		expect(result.rootDir).toBe(packageDirectory);
	});

	it("should absolutize a relative cwd when no rootDir is declared", async () => {
		expect.assertions(1);

		const result = await loadConfig({ cwd: "." });

		expect(result.rootDir).toBe(process.cwd());
	});

	it("should retain the loader error as the cause for a missing explicit config", async () => {
		expect.assertions(1);

		const error = new Error("missing.config.mjs cannot be resolved");
		const { fileSystem } = createMemoryFileSystem();
		async function configLoader(): Promise<never> {
			throw error;
		}

		await expect(
			loadConfig({ configLoader, configPath: "missing.config.mjs", fileSystem }),
		).rejects.toHaveProperty("cause", error);
	});

	it("should pass through auto-discovery loader failures", async () => {
		expect.assertions(1);

		const error = new Error("dependency cannot be resolved");
		async function configLoader(): Promise<never> {
			throw error;
		}

		await expect(
			loadRawConfig({ configLoader, configPath: undefined, cwd: "/repo" }),
		).rejects.toBe(error);
	});

	describe("luau configs", () => {
		it("should discover a jest.config.luau in the working directory", async () => {
			expect.assertions(2);

			const temporaryDirectory = path.resolve("/project");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(temporaryDirectory, "jest.config.luau")]:
					'return { placeFile = "luau.rbxl", test = { verbose = true } }',
			});

			const result = await loadConfig({ cwd: temporaryDirectory, fileSystem });

			expect(result.placeFile).toBe("luau.rbxl");
			expect(result.verbose).toBeTrue();
		});

		it("should load the luau file an explicit config path names", async () => {
			expect.assertions(1);

			const temporaryDirectory = path.resolve("/project");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(temporaryDirectory, "custom.luau")]:
					"return { test = { verbose = true } }",
			});

			const result = await loadConfig({
				configPath: "custom.luau",
				cwd: temporaryDirectory,
				fileSystem,
			});

			expect(result.verbose).toBeTrue();
		});

		it("should run a luau config that holds code through the given child process", async () => {
			expect.assertions(1);

			const temporaryDirectory = path.resolve("/project");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(temporaryDirectory, "jest.config.luau")]:
					'return { placeFile = "place" .. ".rbxl" }',
			});

			await expect(
				loadConfig({
					childProcess: createLuteChildProcess({ version: "9.9.9" }),
					cwd: temporaryDirectory,
					fileSystem,
				}),
			).rejects.toThrow('--version" printed "9.9.9"');
		});

		it("should throw when an explicit luau config path is missing", async () => {
			expect.assertions(1);

			const temporaryDirectory = path.resolve("/project");
			const { fileSystem } = createMemoryFileSystem();

			await expect(
				loadConfig({ configPath: "missing.luau", cwd: temporaryDirectory, fileSystem }),
			).rejects.toThrowWithMessage(Error, "Config file not found: missing.luau");
		});

		it("should anchor a relative rootDir on the luau config's directory", async () => {
			expect.assertions(1);

			const temporaryDirectory = path.resolve("/project");
			const configDirectory = path.join(temporaryDirectory, "packages", "core");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(configDirectory, "jest.config.luau")]: 'return { rootDir = "." }',
			});

			const result = await loadConfig({
				configPath: "packages/core/jest.config.luau",
				cwd: temporaryDirectory,
				fileSystem,
			});

			expect(result.rootDir).toBe(configDirectory);
		});

		it("should anchor a relative workspace.root on the luau config's directory", async () => {
			expect.assertions(1);

			const temporaryDirectory = path.resolve("/project");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(temporaryDirectory, "jest.config.luau")]:
					'return { workspace = { packages = { "packages/*" }, root = "." } }',
			});

			const result = await loadConfig({ cwd: temporaryDirectory, fileSystem });

			expect(result.workspace!.root).toBe(temporaryDirectory);
		});

		it("should reject jest options outside a test block as every format does", async () => {
			expect.assertions(1);

			const temporaryDirectory = path.resolve("/project");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(temporaryDirectory, "jest.config.luau")]: "return { verbose = true }",
			});

			await expect(
				loadConfig({ cwd: temporaryDirectory, fileSystem }),
			).rejects.toThrowWithMessage(
				Error,
				"jest options must be wrapped in a `test:` block. Move these keys under `test:`: verbose",
			);
		});

		it.for(["jest.config.mjs", ".config/jest.json", ".config/jest.config.yaml"])(
			"should name both files before evaluating a conflicting %s",
			async (relativePath) => {
				expect.assertions(1);

				const temporaryDirectory = path.resolve("/project");
				const luauPath = path.join(temporaryDirectory, "jest.config.luau");
				const scriptPath = path.join(temporaryDirectory, relativePath);
				const { fileSystem } = createMemoryFileSystem({
					[luauPath]: "return {}",
					[scriptPath]: "this config must never be evaluated",
				});

				await expect(
					loadConfig({ cwd: temporaryDirectory, fileSystem }),
				).rejects.toThrowWithMessage(
					Error,
					`Found two jest configs: ${scriptPath} and ${luauPath}. Keep one.`,
				);
			},
		);

		it("should load an explicit script config that sits beside a luau config", async () => {
			expect.assertions(1);

			const fixture = loadFixture({ "jest.config.mjs": { test: { verbose: true } } });
			fixture.fileSystem.writeFileSync(
				path.join(fixture.cwd, "jest.config.luau"),
				"return { test = { verbose = false } }",
			);

			const result = await loadConfig({ ...fixture, configPath: "jest.config.mjs" });

			expect(result.verbose).toBeTrue();
		});

		it("should let a luau config extend a script config", async () => {
			expect.assertions(2);

			const fixture = loadFixture({
				"jest.shared.mjs": { test: { verbose: true }, timeout: 12345 },
			});
			fixture.fileSystem.writeFileSync(
				path.join(fixture.cwd, "jest.config.luau"),
				'return { extends = "./jest.shared.mjs", test = { verbose = false } }',
			);

			const result = await loadConfig(fixture);

			expect(result.timeout).toBe(12345);
			expect(result.verbose).toBeFalse();
		});

		it("should let a script config extend a luau config", async () => {
			expect.assertions(2);

			const fixture = loadFixture({
				"jest.config.mjs": { extends: "./base.luau", test: { verbose: false } },
			});
			fixture.fileSystem.writeFileSync(
				path.join(fixture.cwd, "base.luau"),
				"return { timeout = 12345, test = { verbose = true } }",
			);

			const result = await loadConfig(fixture);

			expect(result.timeout).toBe(12345);
			expect(result.verbose).toBeFalse();
		});

		it("should name the extends entry when its luau file is missing", async () => {
			expect.assertions(1);

			const fixture = loadFixture();
			fixture.fileSystem.mkdirSync(fixture.cwd, { recursive: true });
			fixture.fileSystem.writeFileSync(
				path.join(fixture.cwd, "jest.config.luau"),
				'return { extends = "./missing.luau" }',
			);

			await expect(loadConfig(fixture)).rejects.toThrowWithMessage(
				Error,
				/Failed to resolve extends "\.\/missing\.luau"/,
			);
		});
	});
});

function loadFixture(layers: Parameters<typeof createConfigFixture>[0] = {}) {
	const fixture = createConfigFixture(layers);
	return { ...fixture, cwd: fixture.rootDirectory };
}

describe("config layer resolution", () => {
	it("should anchor roots to the loaded file and retain absolute roots", async () => {
		expect.assertions(4);

		const fixture = loadFixture({
			"jest.config.mjs": {
				rootDir: "package",
				workspace: { packages: ["packages/*"], root: "." },
			},
		});
		const result = await loadConfig(fixture);
		const absolute = await loadConfig(
			loadFixture({
				"jest.config.mjs": {
					rootDir: "D:/repo/foo",
					workspace: { packages: ["packages/*"], root: path.resolve("workspace") },
				},
			}),
		);

		expect(result.rootDir).toBe(path.join(fixture.rootDirectory, "package"));
		expect(result.workspace!.root).toBe(fixture.rootDirectory);
		expect(absolute.rootDir).toBe("D:/repo/foo");
		expect(absolute.workspace!.root).toBe(path.resolve("workspace"));
	});

	it("should return defaults when a search finds no file", async () => {
		expect.assertions(2);

		const fixture = loadFixture();
		const result = await loadConfig(fixture);

		expect(result.rootDir).toBe(fixture.rootDirectory);
		expect(result.verbose).toBeFalse();
	});

	it("should distinguish a missing explicit config from a loader failure", async () => {
		expect.assertions(2);

		const fixture = loadFixture();
		const broken = loadFixture({ "broken.mjs": new Error("invalid syntax") });

		await expect(
			loadConfig({ ...fixture, configPath: path.join(fixture.rootDirectory, "missing.mjs") }),
		).rejects.toThrow("Config file not found");
		await expect(
			loadConfig({ ...broken, configPath: path.join(broken.rootDirectory, "broken.mjs") }),
		).rejects.toThrow("invalid syntax");
	});

	it("should support a loader with no resolved filename", async () => {
		expect.assertions(1);

		const configLoader: ConfigLoader = fromAny(async () => {
			return {
				config: { test: { verbose: true } },
			};
		});

		const result = await loadConfig({ configLoader });

		expect(result.verbose).toBeTrue();
	});
});

describe("legacy config functions", () => {
	it.for([
		fromAny<Config, { roots: () => Array<string> }>({ roots: () => ["legacy"] }),
		fromAny<Config, { roots: Array<string> }>({ roots: ["legacy"] }),
	])("should reject legacy root merger fields after resolving them", async (layer) => {
		expect.assertions(1);

		await expect(loadConfig(loadFixture({ "jest.config.mjs": layer }))).rejects.toThrow(
			"jest options must be wrapped",
		);
	});
});

type C12Loader = (options: LoadConfigOptions) => Promise<C12ResolvedConfig>;

function emptyConfigLoader(): Mock<C12Loader> {
	const configLoader = vi.fn<C12Loader>();
	configLoader.mockResolvedValue({ config: {}, cwd: "/repo", layers: [] });

	return configLoader;
}

function seamsFor(configLoader: Mock<C12Loader>, fileSystem: FileSystem): ConfigLoadOptions {
	return { configLoader: fromAny(configLoader), fileSystem };
}

describe("c12 loader boundary", () => {
	it("should isolate implicit config discovery from ambient configuration sources", async () => {
		expect.assertions(3);

		const configLoader = emptyConfigLoader();
		const { fileSystem } = createMemoryFileSystem();

		await expect(
			loadRawConfig({
				configPath: undefined,
				cwd: "/repo",
				...seamsFor(configLoader, fileSystem),
			}),
		).resolves.toStrictEqual({});

		const [options] = configLoader.mock.calls[0]!;
		const { merger, ...plainOptions } = options;

		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFileRequired: false,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should require and name an explicitly requested config file", async () => {
		expect.assertions(2);

		const configLoader = emptyConfigLoader();
		const { fileSystem } = createMemoryFileSystem();

		await loadRawConfig({
			configPath: "configs/jest.config.ts",
			cwd: "/repo",
			...seamsFor(configLoader, fileSystem),
		});

		const [options] = configLoader.mock.calls[0]!;
		const { merger, ...plainOptions } = options;

		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFile: "configs/jest.config.ts",
			configFileRequired: true,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should provide the filesystem importer only in SEA mode", async () => {
		expect.assertions(3);

		const configLoader = emptyConfigLoader();
		const { fileSystem } = createMemoryFileSystem();
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		await loadRawConfig({
			configPath: "jest.config.json",
			cwd: "/repo",
			...seamsFor(configLoader, fileSystem),
		});

		const [options] = configLoader.mock.calls[0]!;
		const { import: importConfig, merger, ...plainOptions } = options;

		expect(importConfig).toBeTypeOf("function");
		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFile: "jest.config.json",
			configFileRequired: true,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});
});
