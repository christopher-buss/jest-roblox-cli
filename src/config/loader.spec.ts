import { fromAny } from "@total-typescript/shoehorn";

import type { LoadConfigOptions } from "c12";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createConfigFixture } from "#test/mocks/config-fixture.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { ConfigLoader } from "./loader.ts";
import { loadConfig, loadRawConfig, resolveConfig } from "./loader.ts";
import type { Config, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

describe(resolveConfig, () => {
	it("should use defaults when no config provided", () => {
		expect.assertions(3);

		const result = resolveConfig({});

		expect(result.testMatch).toStrictEqual(DEFAULT_CONFIG.testMatch);
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

	it("should retain raw values and merge a shared base reached by two branches", async () => {
		expect.assertions(3);

		const fixture = loadFixture({
			"a.mjs": { extends: "./base.mjs", timeout: 1000 },
			"b.mjs": { extends: "./base.mjs", port: 5000 },
			"base.mjs": { test: { setupFiles: ["shared.luau"] } },
			"jest.config.mjs": { extends: ["./a.mjs", "./b.mjs"], test: { verbose: true } },
		});
		const result = await loadRawConfig(fixture);

		expect(result.timeout).toBe(1000);
		expect(result.port).toBe(5000);
		expect(result.test!.setupFiles).toStrictEqual(["shared.luau", "shared.luau"]);
	});

	it("should resolve an absolute extends path", async () => {
		expect.assertions(1);

		const parent = path.resolve("parent.mjs");
		const fixture = loadFixture({
			"jest.config.mjs": { extends: parent },
			[parent]: { timeout: 1234 },
		});

		const result = await loadConfig(fixture);

		expect(result.timeout).toBe(1234);
	});

	it("should reject circular inheritance and retain missing-parent context", async () => {
		expect.assertions(2);

		const cycle = loadFixture({
			"a.mjs": { extends: "./jest.config.mjs" },
			"jest.config.mjs": { extends: "./a.mjs" },
		});
		const missing = loadFixture({ "jest.config.mjs": { extends: "./missing.mjs" } });

		await expect(loadConfig(cycle)).rejects.toThrow("Circular extends detected");
		await expect(loadConfig(missing)).rejects.toThrow("Failed to resolve extends");
	});

	it("should resolve merger functions against defaults", async () => {
		expect.assertions(1);

		const layer: Config = fromAny({
			test: {
				coveragePathIgnorePatterns: () => ["ignored"],
				coverageThreshold: (defaults: NonNullable<ResolvedConfig["coverageThreshold"]>) => {
					return { ...defaults, lines: 80 };
				},
				reporters: () => ["default"],
				roots: () => ["custom-root"],
				setupFiles: (defaults: Array<string>) => {
					return [...defaults, "setup.luau"];
				},
				snapshotFormat: (defaults: NonNullable<ResolvedConfig["snapshotFormat"]>) => {
					return { ...defaults, printBasicPrototype: false };
				},
				testMatch: (defaults: Array<string>) => {
					return [...defaults, "**/*.test.ts"];
				},
			},
		});
		const result = await loadConfig(loadFixture({ "jest.config.mjs": layer }));

		expect(result).toMatchObject({
			coveragePathIgnorePatterns: ["ignored"],
			coverageThreshold: { lines: 80 },
			reporters: ["default"],
			roots: ["custom-root"],
			setupFiles: ["setup.luau"],
			snapshotFormat: { printBasicPrototype: false },
			testMatch: expect.arrayContaining(["**/*.test.ts"]),
		});
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

	it("should import a JSON config through the supplied filesystem in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const { fileSystem } = createMemoryFileSystem({
			"/config.json": '{"test":{"verbose":true}}',
		});
		const configLoader: ConfigLoader = fromAny(async (options: LoadConfigOptions<Config>) => {
			return { config: await options.import!("/config.json") };
		});

		const result = await loadConfig({ configLoader, fileSystem });

		expect(result.verbose).toBeTrue();
	});

	it("should import an ESM config through the native SEA loader", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const configLoader: ConfigLoader = fromAny(async (options: LoadConfigOptions<Config>) => {
			const module: { default: Config } = fromAny(
				await options.import!(
					path.resolve(import.meta.dirname, "../../test/fixtures/sea.config.mjs"),
				),
			);
			return { config: module.default };
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
