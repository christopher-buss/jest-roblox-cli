import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { applySnapshotFormatDefaults, loadConfig, resolveConfig } from "./loader.ts";
import type { Config } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

describe(applySnapshotFormatDefaults, () => {
	it("should default printBasicPrototype to true for luau project", () => {
		expect.assertions(1);

		const result = applySnapshotFormatDefaults(DEFAULT_CONFIG, true);

		expect(result.snapshotFormat?.printBasicPrototype).toBe(true);
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

		expect(result.snapshotFormat?.printBasicPrototype).toBe(true);
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
			testMatch: ["**/*.test.ts"],
			verbose: true,
		};
		const result = resolveConfig(config);

		expect(result.testMatch).toStrictEqual(["**/*.test.ts"]);
		expect(result.verbose).toBe(true);
	});

	it("should preserve rootDir from config", () => {
		expect.assertions(1);

		const config: Config = {
			rootDir: "/custom/path",
		};
		const result = resolveConfig(config);

		expect(result.rootDir).toBe("/custom/path");
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

		const result = resolveConfig({ coverageDirectory: "my-coverage" });

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
		fs.writeFileSync(configPath, "export default { verbose: true };");

		const result = await loadConfig(configPath, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.verbose).toBe(true);
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
		fs.writeFileSync(configPath, "export default { verbose: true };");

		const result = await loadConfig(configPath, parentDirectory);
		fs.rmSync(parentDirectory, { force: true, recursive: true });

		expect(path.normalize(result.rootDir)).toBe(path.normalize(parentDirectory));
	});

	describe("extends with defuFn merger", () => {
		it("should replace parent array when child uses a function value", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(parentPath, 'export default { setupFiles: ["parent-setup.luau"] };');

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", setupFiles: () => ["child-setup.luau"] };',
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
				'export default { setupFiles: ["keep.luau", "remove.luau"] };',
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", setupFiles: (defaults) => defaults.filter(f => !f.includes("remove")) };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["keep.luau"]);
		});

		it("should concatenate arrays when child uses plain array (default defu behavior)", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(parentPath, 'export default { setupFiles: ["parent-setup.luau"] };');

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", setupFiles: ["child-setup.luau"] };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["child-setup.luau", "parent-setup.luau"]);
		});

		it("should override scalar values from parent", async () => {
			expect.assertions(2);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(parentPath, "export default { verbose: true, timeout: 5000 };");

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", timeout: 10000 };',
			);

			const result = await loadConfig(childPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.timeout).toBe(10000);
			expect(result.verbose).toBe(true);
		});

		it("should deep-merge nested objects like snapshotFormat", async () => {
			expect.assertions(1);

			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
			const parentPath = path.join(temporaryDirectory, "parent.config.mjs");
			fs.writeFileSync(
				parentPath,
				"export default { snapshotFormat: { indent: 4, min: false } };",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				childPath,
				'export default { extends: "./parent.config.mjs", snapshotFormat: { min: true } };',
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
				'export default { setupFiles: () => ["standalone.luau"] };',
			);

			const result = await loadConfig(configPath, temporaryDirectory);
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });

			expect(result.setupFiles).toStrictEqual(["standalone.luau"]);
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
			'console.warn("some other warning"); export default { verbose: true };',
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

	it("should throw when extends fails to resolve", async () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(
			configPath,
			'export default { extends: "../../jest.shared", verbose: true };',
		);

		await expect(loadConfig(configPath, temporaryDirectory)).rejects.toThrowWithMessage(
			Error,
			/Failed to resolve extends.*jest\.shared.*file extension/,
		);

		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});
});
