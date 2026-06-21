import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { applySnapshotFormatDefaults, loadConfig, loadRawConfig, resolveConfig } from "./loader.ts";
import type { Config } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

describe(applySnapshotFormatDefaults, () => {
	it("should default printBasicPrototype to true for luau project", () => {
		expect.assertions(1);

		const result = applySnapshotFormatDefaults(DEFAULT_CONFIG, true);

		expect(result.snapshotFormat?.printBasicPrototype).toBeTrue();
	});

	it("should default printBasicPrototype to false for typescript project", () => {
		expect.assertions(1);

		const result = applySnapshotFormatDefaults(DEFAULT_CONFIG, false);

		expect(result.snapshotFormat?.printBasicPrototype).toBeFalse();
	});

	it("should preserve explicit printBasicPrototype=true even for typescript project", () => {
		expect.assertions(1);

		const config = { ...DEFAULT_CONFIG, snapshotFormat: { printBasicPrototype: true } };
		const result = applySnapshotFormatDefaults(config, false);

		expect(result.snapshotFormat?.printBasicPrototype).toBeTrue();
	});

	it("should preserve explicit printBasicPrototype=false even for luau project", () => {
		expect.assertions(1);

		const config = { ...DEFAULT_CONFIG, snapshotFormat: { printBasicPrototype: false } };
		const result = applySnapshotFormatDefaults(config, true);

		expect(result.snapshotFormat?.printBasicPrototype).toBeFalse();
	});

	it("should not mutate the original config", () => {
		expect.assertions(1);

		const config = { ...DEFAULT_CONFIG };
		applySnapshotFormatDefaults(config, true);

		expect((config as Record<string, unknown>)["snapshotFormat"]).toBeUndefined();
	});
});

describe(resolveConfig, () => {
	it("should use defaults when no config provided", () => {
		expect.assertions(3);

		const result = resolveConfig({});

		expect(result.testMatch).toStrictEqual(DEFAULT_CONFIG.testMatch);
		expect(result.verbose).toBeFalse();
		expect(result.silent).toBeFalse();
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

		const config = { backend: "not-a-backend" as string } as Config;

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

describe(loadConfig, () => {
	it("should return defaults when no config file found", async () => {
		expect.assertions(2);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const result = await loadConfig(undefined, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.rootDir).toBe(temporaryDirectory);
		expect(result.verbose).toBe(DEFAULT_CONFIG.verbose);
	});

	it("should load config from explicit path", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "custom.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBeTrue();
	});

	it("should default rootDir to cwd", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const result = await loadConfig(undefined, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.rootDir).toBe(temporaryDirectory);
	});

	it("should throw when explicit config path not found", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const missingPath = path.join(temporaryDirectory, "nonexistent.config.ts");

		await expect(loadConfig(missingPath, temporaryDirectory)).rejects.toThrow(
			"Config file not found",
		);

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	it("should surface parse errors without masking as not found", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		fs.writeFileSync(path.join(temporaryDirectory, "jest.config.mjs"), "export default {{{");

		await expect(loadConfig(undefined, temporaryDirectory)).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error && !error.message.includes("Config file not found"),
		);

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	it("should validate backend from config file", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, 'export default { backend: "not-a-backend" };');

		await expect(loadConfig(configPath, temporaryDirectory)).rejects.toThrow("Invalid config");

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	it("should reject config file with invalid port type", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, 'export default { port: "not-a-number" };');

		await expect(loadConfig(configPath, temporaryDirectory)).rejects.toThrow("Invalid config");

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	it("should reject config file with undeclared keys", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		// Intentional typo to test undeclared key rejection
		// cspell:disable-next-line
		fs.writeFileSync(configPath, 'export default { bakcend: "studio" };');

		await expect(loadConfig(configPath, temporaryDirectory)).rejects.toThrow("Invalid config");

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	it("should default rootDir to cwd even when config file is in a subdirectory", async () => {
		expect.assertions(1);

		const parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const subDirectory = path.join(parentDirectory, "packages", "core");
		fs.mkdirSync(subDirectory, { recursive: true });
		const configPath = path.join(subDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadConfig(configPath, parentDirectory);
		fs.rmSync(parentDirectory, { force: true, recursive: true });

		expect(path.normalize(result.rootDir)).toBe(path.normalize(parentDirectory));
	});

	// TODO: rewrite result.setupFiles → result.test.setupFiles
	// after the consumer refactor that drops the ResolvedConfig flattening.
	describe("extends with defuFn merger", () => {
		it("should replace parent array when child uses a function value", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(
				parentPath,
				'export default { test: { setupFiles: ["parent-setup.luau"] } };',
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", test: { setupFiles: () => ["child-setup.luau"] } };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["child-setup.luau"]);
		});

		it("should allow child function to filter parent array values", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(
				parentPath,
				'export default { test: { setupFiles: ["keep.luau", "remove.luau"] } };',
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", test: { setupFiles: (defaults) => defaults.filter(f => !f.includes("remove")) } };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["keep.luau"]);
		});

		it("should concatenate arrays when child uses plain array (default defu behavior)", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(
				parentPath,
				'export default { test: { setupFiles: ["parent-setup.luau"] } };',
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", test: { setupFiles: ["child-setup.luau"] } };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["child-setup.luau", "parent-setup.luau"]);
		});

		it("should override scalar values from parent", async () => {
			expect.assertions(2);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(
				parentPath,
				"export default { test: { verbose: true }, timeout: 5000 };",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", timeout: 10000 };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.timeout).toBe(10000);
			expect(result.verbose).toBeTrue();
		});

		it("should deep-merge nested objects like snapshotFormat", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(
				parentPath,
				"export default { test: { snapshotFormat: { indent: 4, min: false } } };",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", test: { snapshotFormat: { min: true } } };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.snapshotFormat).toStrictEqual({ indent: 4, min: true });
		});

		it("should resolve function values when config has no parent", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { setupFiles: () => ["standalone.luau"] } };',
			);

			const result = await loadConfig(configPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["standalone.luau"]);
		});

		it("should pass empty defaults to standalone test merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { setupFiles: defaults => [...defaults, "standalone.luau"] } };',
			);

			const result = await loadConfig(configPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["standalone.luau"]);
		});

		it("should pass configured defaults to standalone test merger functions", async () => {
			expect.assertions(2);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { testMatch: defaults => [...defaults, "**/*.custom.ts"] } };',
			);

			const result = await loadConfig(configPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.testMatch).toContain("**/*.spec.ts");
			expect(result.testMatch).toContain("**/*.custom.ts");
		});

		it("should pass object defaults to standalone test merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				"export default { test: { snapshotFormat: defaults => ({ ...defaults, min: true }) } };",
			);

			const result = await loadConfig(configPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.snapshotFormat).toStrictEqual({ min: true });
		});

		it("should reject function values for non-mergeable keys", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(configPath, 'export default { backend: () => "studio" };');

			await expect(loadConfig(configPath, temporaryDirectory)).rejects.toThrow(
				"Invalid config",
			);

			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		});

		it("should pass empty defaults to standalone root-level merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { luauRoots: defaults => [...defaults, "child-out"] };',
			);

			const result = await loadConfig(configPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.luauRoots).toStrictEqual(["child-out"]);
		});
	});

	describe("extends across directories", () => {
		function setupTemporaryDirectory() {
			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			onTestFinished(() => {
				fs.rmSync(temporaryDirectory, { force: true, recursive: true });
			});
			return temporaryDirectory;
		}

		it("should resolve parent in workspace root from child in nested subdirectory", async () => {
			expect.assertions(2);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				"export default { timeout: 12345, test: { verbose: true } };",
			);

			const childDirectory = path.join(temporaryDirectory, "packages", "test-utils");
			fs.mkdirSync(childDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(childDirectory, "jest.config.mjs"),
				'export default { extends: "../../jest.shared.mjs", test: { passWithNoTests: true } };',
			);

			const result = await loadConfig(undefined, childDirectory);

			expect(result.timeout).toBe(12345);
			expect(result.verbose).toBeTrue();
		});

		it("should resolve extends against config file dir, not process.cwd()", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				"export default { timeout: 54321 };",
			);

			const childDirectory = path.join(temporaryDirectory, "sub", "pkg");
			fs.mkdirSync(childDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(childDirectory, "jest.config.mjs"),
				'export default { extends: "../../jest.shared.mjs" };',
			);

			const originalCwd = process.cwd();
			onTestFinished(() => {
				process.chdir(originalCwd);
			});
			process.chdir(os.tmpdir());

			const result = await loadConfig(undefined, childDirectory);

			expect(result.timeout).toBe(54321);
		});

		it("should resolve nested extends chain across directories", async () => {
			expect.assertions(3);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.base.mjs"),
				'export default { backend: "open-cloud" };',
			);

			const middleDirectory = path.join(temporaryDirectory, "shared");
			fs.mkdirSync(middleDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(middleDirectory, "jest.shared.mjs"),
				'export default { extends: "../jest.base.mjs", timeout: 9999 };',
			);

			const childDirectory = path.join(temporaryDirectory, "packages", "core");
			fs.mkdirSync(childDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(childDirectory, "jest.config.mjs"),
				'export default { extends: "../../shared/jest.shared.mjs", test: { verbose: true } };',
			);

			const result = await loadConfig(undefined, childDirectory);

			expect(result.backend).toBe("open-cloud");
			expect(result.timeout).toBe(9999);
			expect(result.verbose).toBeTrue();
		});

		it("should load diamond extends with shared base ancestor", async () => {
			expect.assertions(3);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "base.mjs"),
				'export default { backend: "open-cloud" };',
			);
			fs.writeFileSync(
				path.join(temporaryDirectory, "left.mjs"),
				'export default { extends: "./base.mjs", timeout: 1111 };',
			);
			fs.writeFileSync(
				path.join(temporaryDirectory, "right.mjs"),
				'export default { extends: "./base.mjs", test: { verbose: true } };',
			);
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.config.mjs"),
				'export default { extends: ["./left.mjs", "./right.mjs"] };',
			);

			const result = await loadConfig(undefined, temporaryDirectory);

			expect(result.backend).toBe("open-cloud");
			expect(result.timeout).toBe(1111);
			expect(result.verbose).toBeTrue();
		});

		it("should resolve absolute extends path verbatim", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			const parentPath = path.join(temporaryDirectory, "jest.shared.mjs");
			fs.writeFileSync(parentPath, "export default { timeout: 2222 };");

			const childDirectory = path.join(temporaryDirectory, "deep", "nested");
			fs.mkdirSync(childDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(childDirectory, "jest.config.mjs"),
				`export default { extends: ${JSON.stringify(parentPath)} };`,
			);

			const result = await loadConfig(undefined, childDirectory);

			expect(result.timeout).toBe(2222);
		});

		it("should detect true cycle in extends chain", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "a.mjs"),
				'export default { extends: "./b.mjs" };',
			);
			fs.writeFileSync(
				path.join(temporaryDirectory, "b.mjs"),
				'export default { extends: "./a.mjs" };',
			);

			await expect(
				loadConfig(path.join(temporaryDirectory, "a.mjs"), temporaryDirectory),
			).rejects.toThrowWithMessage(Error, /Circular extends detected/);
		});

		// cspell:disable-next-line
		it("should resolve extensionless extends via c12 extension search", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				"export default { timeout: 7777 };",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(childPath, 'export default { extends: "./jest.shared" };');

			const result = await loadConfig(childPath, temporaryDirectory);

			expect(result.timeout).toBe(7777);
		});

		it("should surface parent parse errors with extends context, not as 'not found'", async () => {
			expect.assertions(4);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				"export default {{{",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(childPath, 'export default { extends: "./jest.shared.mjs" };');

			const error = await loadConfig(childPath, temporaryDirectory).catch(
				(err: unknown) => err,
			);

			expect(error).toBeInstanceOf(Error);

			const { message } = error as Error;

			expect(message).toContain("Failed to resolve extends");
			expect(message).not.toContain("Config file not found");
			expect(message).toMatch(/jest\.shared\.mjs/);
		});

		it("should surface explicit-path parse errors without wrapping as 'not found'", async () => {
			expect.assertions(2);

			const temporaryDirectory = setupTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(configPath, "export default {{{");

			const error = await loadConfig(configPath, temporaryDirectory).catch(
				(err: unknown) => err,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("Config file not found");
		});

		it("should anchor a relative workspace.root to the declaring shared config dir", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				'export default { workspace: { packages: ["packages/*"], root: "." } };',
			);

			const childDirectory = path.join(temporaryDirectory, "packages", "core");
			fs.mkdirSync(childDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(childDirectory, "jest.config.mjs"),
				'export default { extends: "../../jest.shared.mjs" };',
			);

			const result = await loadConfig(undefined, childDirectory);

			// c12 canonicalizes the discovered config path (realpath), so on
			// macOS the anchored root resolves under /private/tmp; realpath the
			// expected dir to match on symlinked-tmp hosts (a no-op where tmp is
			// not a link).
			expect(result.workspace?.root).toBe(fs.realpathSync(temporaryDirectory));
		});

		it("should anchor a relative workspace.root declared without extends", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.config.mjs"),
				'export default { workspace: { packages: ["packages/*"], root: "." } };',
			);

			const result = await loadConfig(undefined, temporaryDirectory);

			// realpath the expected dir so the assertion holds on symlinked-tmp
			// hosts (macOS resolves the loaded config path under /private/tmp).
			expect(result.workspace?.root).toBe(fs.realpathSync(temporaryDirectory));
		});

		it("should leave an absolute workspace.root untouched", async () => {
			expect.assertions(1);

			const temporaryDirectory = setupTemporaryDirectory();
			const absoluteRoot = path.resolve(temporaryDirectory, "elsewhere");
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.config.mjs"),
				`export default { workspace: { packages: ["packages/*"], root: ${JSON.stringify(absoluteRoot)} } };`,
			);

			const result = await loadConfig(undefined, temporaryDirectory);

			expect(result.workspace?.root).toBe(absoluteRoot);
		});
	});

	it("should forward non-extend warnings to console.warn", async () => {
		expect.assertions(1);

		const warnings: Array<string> = [];
		const originalWarn = console.warn;

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		// Config that calls console.warn during evaluation — simulates c12
		// emitting a non-extend warning during config load.
		fs.writeFileSync(
			configPath,
			'console.warn("some other warning"); export default { test: { verbose: true } };',
		);

		console.warn = (...args: Array<unknown>) => {
			warnings.push(args.join(" "));
		};

		try {
			await loadConfig(configPath, temporaryDirectory);
		} finally {
			console.warn = originalWarn;
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}

		expect(warnings).toContain("some other warning");
	});

	it("should load JSON config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.json");
		fs.writeFileSync(configPath, JSON.stringify({ test: { verbose: true } }));

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBeTrue();
	});

	it("should load ESM config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBeTrue();
	});

	it("should load TypeScript config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.ts");
		fs.writeFileSync(
			configPath,
			"type C = { test?: { verbose?: boolean } };\n" +
				"export default { test: { verbose: true } } satisfies C;\n",
		);

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBeTrue();
	});

	it("should load ESM TypeScript (.mts) config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mts");
		fs.writeFileSync(
			configPath,
			"type C = { test?: { verbose?: boolean } };\n" +
				"export default { test: { verbose: true } } satisfies C;\n",
		);

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBeTrue();
	});

	it("should load CommonJS TypeScript (.cts) config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.cts");
		// `.cts` is CommonJS — native type-stripping rejects `export default` /
		// `export =`, so a `.cts` config uses `module.exports`.
		fs.writeFileSync(
			configPath,
			"interface C { test?: { verbose?: boolean } }\n" +
				"const config: C = { test: { verbose: true } };\n" +
				"module.exports = config;\n",
		);

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBeTrue();
	});

	it("should throw with clear message when extends target is missing", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(
			configPath,
			'export default { extends: "./does-not-exist.mjs", test: { verbose: true } };',
		);

		await expect(loadConfig(configPath, temporaryDirectory)).rejects.toThrowWithMessage(
			Error,
			/Failed to resolve extends.*does-not-exist\.mjs/,
		);

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});
});

describe(loadRawConfig, () => {
	it("should leave user-omitted fields undefined (no DEFAULT_CONFIG merge)", async () => {
		expect.assertions(4);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raw-config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadRawConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.test?.verbose).toBeTrue();
		expect(result.backend).toBeUndefined();
		expect(result.color).toBeUndefined();
		expect(result.rootDir).toBeUndefined();
	});

	it("should return empty object when no config file found", async () => {
		expect.assertions(2);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raw-config-test-"));
		const result = await loadRawConfig(undefined, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.backend).toBeUndefined();
		expect(result.test).toBeUndefined();
	});

	it("should throw when explicit config path not found", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raw-config-test-"));
		const missingPath = path.join(temporaryDirectory, "nonexistent.config.ts");

		await expect(loadRawConfig(missingPath, temporaryDirectory)).rejects.toThrow(
			"Config file not found",
		);

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	it("should resolve extends chains the same as loadConfig", async () => {
		expect.assertions(2);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raw-config-test-"));
		const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
		fs.writeFileSync(
			parentPath,
			'export default { test: { setupFiles: ["parent-setup.luau"] } };',
		);

		const childPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(
			childPath,
			'export default { extends: "./parent.config.mjs", test: { verbose: true } };',
		);

		const result = await loadRawConfig(childPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.test?.setupFiles).toStrictEqual(["parent-setup.luau"]);
		expect(result.test?.verbose).toBeTrue();
	});

	it("should resolve function-valued merger fields against empty defaults", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "raw-config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(
			configPath,
			'export default { test: { setupFiles: () => ["child-setup.luau"] } };',
		);

		const result = await loadRawConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.test?.setupFiles).toStrictEqual(["child-setup.luau"]);
	});
});
