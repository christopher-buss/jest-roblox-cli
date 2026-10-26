import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { DEFAULT_CONFIG, loadConfig } from "../../src/index.ts";

function isErrorWithoutNotFoundMessage(error: unknown): boolean {
	return error instanceof Error && !error.message.includes("Config file not found");
}

function makeTemporaryDirectory(prefix = "config-test-"): string {
	const temporaryDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	onTestFinished(() => {
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});

	return temporaryDirectory;
}

describe(loadConfig, { timeout: 1000 }, () => {
	it("should return defaults when no config file found", async () => {
		expect.assertions(2);

		const temporaryDirectory = makeTemporaryDirectory();
		const result = await loadConfig({ cwd: temporaryDirectory });

		expect(result.rootDir).toBe(temporaryDirectory);
		expect(result.verbose).toBe(DEFAULT_CONFIG.verbose);
	});

	it("should load config from explicit path", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "custom.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadConfig({ configPath, cwd: temporaryDirectory });

		expect(result.verbose).toBeTrue();
	});

	it("should default rootDir to cwd", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		const result = await loadConfig({ cwd: temporaryDirectory });

		expect(result.rootDir).toBe(temporaryDirectory);
	});

	it("should throw when explicit config path not found", async () => {
		expect.assertions(2);

		const temporaryDirectory = makeTemporaryDirectory();
		const missingPath = path.join(temporaryDirectory, "nonexistent.config.ts");

		const error = await loadConfig({ configPath: missingPath, cwd: temporaryDirectory }).catch(
			(err) => err,
		);

		assert(error instanceof Error);

		expect(error.message).toBe(`Config file not found: ${missingPath}`);
		expect(error.cause).toBeInstanceOf(Error);
	});

	it("should surface parse errors without masking as not found", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		fs.writeFileSync(path.join(temporaryDirectory, "jest.config.mjs"), "export default {{{");

		await expect(loadConfig({ cwd: temporaryDirectory })).rejects.toSatisfy(
			isErrorWithoutNotFoundMessage,
		);
	});

	it("should validate backend from config file", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, 'export default { backend: "not-a-backend" };');

		await expect(loadConfig({ configPath, cwd: temporaryDirectory })).rejects.toThrow(
			"Invalid config",
		);
	});

	it("should reject config file with invalid port type", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, 'export default { port: "not-a-number" };');

		await expect(loadConfig({ configPath, cwd: temporaryDirectory })).rejects.toThrow(
			"Invalid config",
		);
	});

	it("should reject config file with undeclared keys", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");

		// cspell:disable-next-line
		fs.writeFileSync(configPath, 'export default { bakcend: "studio" };');

		await expect(loadConfig({ configPath, cwd: temporaryDirectory })).rejects.toThrow(
			"Invalid config",
		);
	});

	it("should default rootDir to cwd even when config file is in a subdirectory", async () => {
		expect.assertions(1);

		const parentDirectory = makeTemporaryDirectory();
		const subdirectory = path.join(parentDirectory, "packages", "core");
		fs.mkdirSync(subdirectory, { recursive: true });
		const configPath = path.join(subdirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadConfig({ configPath, cwd: parentDirectory });

		expect(path.normalize(result.rootDir)).toBe(path.normalize(parentDirectory));
	});

	it("should resolve a relative rootDir against an explicit config path", async () => {
		expect.assertions(1);

		const workspaceRoot = makeTemporaryDirectory();
		const packageDirectory = path.join(workspaceRoot, "packages", "core");
		fs.mkdirSync(packageDirectory, { recursive: true });
		const configPath = path.join(packageDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, 'export default { rootDir: "." };');

		const result = await loadConfig({ configPath, cwd: workspaceRoot });

		expect(result.rootDir).toBe(packageDirectory);
	});

	it("should resolve a relative rootDir against the load directory", async () => {
		expect.assertions(1);

		const packageDirectory = makeTemporaryDirectory();
		fs.writeFileSync(
			path.join(packageDirectory, "jest.config.mjs"),
			'export default { rootDir: "." };',
		);

		const result = await loadConfig({ cwd: packageDirectory });

		expect(result.rootDir).toBe(packageDirectory);
	});

	it("should anchor the expanded log paths on a relative rootDir", async () => {
		expect.assertions(2);

		const packageDirectory = makeTemporaryDirectory();
		fs.writeFileSync(
			path.join(packageDirectory, "jest.config.mjs"),
			'export default { gameOutput: true, outputFile: true, rootDir: "." };',
		);

		const result = await loadConfig({ cwd: packageDirectory });

		expect(result.gameOutput).toBe(path.join(packageDirectory, "game-output.log"));
		expect(result.outputFile).toBe(path.join(packageDirectory, "jest-output.log"));
	});

	it("should anchor the place file on a relative rootDir", async () => {
		expect.assertions(1);

		const packageDirectory = makeTemporaryDirectory();
		fs.writeFileSync(
			path.join(packageDirectory, "jest.config.mjs"),
			'export default { placeFile: "build/test.rbxl", rootDir: "." };',
		);

		const result = await loadConfig({ cwd: packageDirectory });

		expect(result).toMatchObject({ placeFile: "build/test.rbxl", rootDir: packageDirectory });
	});

	it("should anchor the coverage universe on a relative rootDir", async () => {
		expect.assertions(1);

		const packageDirectory = makeTemporaryDirectory();
		fs.writeFileSync(
			path.join(packageDirectory, "jest.config.mjs"),
			'export default { rootDir: "." };',
		);

		const result = await loadConfig({ cwd: packageDirectory });

		expect(result.rootDir).toBe(packageDirectory);
	});

	it("should keep a rootDir that is absolute on any host", async () => {
		expect.assertions(2);

		const packageDirectory = makeTemporaryDirectory();
		const configPath = path.join(packageDirectory, "jest.config.mjs");

		fs.writeFileSync(configPath, 'export default { rootDir: "D:/repo/foo" };');
		const windowsRoot = await loadConfig({ cwd: packageDirectory });
		fs.writeFileSync(configPath, 'export default { rootDir: "/repo/foo" };');
		const posixRoot = await loadConfig({ cwd: packageDirectory });

		expect(windowsRoot.rootDir).toBe("D:/repo/foo");
		expect(posixRoot.rootDir).toBe("/repo/foo");
	});

	describe("extends with defuFn merger", () => {
		it("should replace parent array when child uses a function value", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ configPath: childPath, cwd: temporaryDirectory });

			expect(result.setupFiles).toStrictEqual(["child-setup.luau"]);
		});

		it("should allow child function to filter parent array values", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ configPath: childPath, cwd: temporaryDirectory });

			expect(result.setupFiles).toStrictEqual(["keep.luau"]);
		});

		it("should concatenate arrays when child uses plain array (default defu behavior)", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ configPath: childPath, cwd: temporaryDirectory });

			expect(result.setupFiles).toStrictEqual(["child-setup.luau", "parent-setup.luau"]);
		});

		it("should override scalar values from parent", async () => {
			expect.assertions(2);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ configPath: childPath, cwd: temporaryDirectory });

			expect(result.timeout).toBe(10000);
			expect(result.verbose).toBeTrue();
		});

		it("should deep-merge nested objects like snapshotFormat", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ configPath: childPath, cwd: temporaryDirectory });

			expect(result.snapshotFormat).toStrictEqual({ indent: 4, min: true });
		});

		it("should resolve function values when config has no parent", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { setupFiles: () => ["standalone.luau"] } };',
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.setupFiles).toStrictEqual(["standalone.luau"]);
		});

		it("should pass empty defaults to standalone test merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { setupFiles: defaults => [...defaults, "standalone.luau"] } };',
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.setupFiles).toStrictEqual(["standalone.luau"]);
		});

		it("should pass configured defaults to standalone test merger functions", async () => {
			expect.assertions(2);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { testMatch: defaults => [...defaults, "**/*.custom.ts"] } };',
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.testMatch).toContain("**/*.spec.ts");
			expect(result.testMatch).toContain("**/*.custom.ts");
		});

		it("should append to the built-in copy-ignore patterns via a merger function", async () => {
			expect.assertions(3);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { test: { coverageCopyIgnorePatterns: defaults => [...defaults, "**/*.tsbuildinfo"] } };',
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.coverageCopyIgnorePatterns).toContain("**/*.d.ts");
			expect(result.coverageCopyIgnorePatterns).toContain("**/*.d.ts.map");
			expect(result.coverageCopyIgnorePatterns).toContain("**/*.tsbuildinfo");
		});

		it("should pass object defaults to standalone test merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				"export default { test: { snapshotFormat: defaults => ({ ...defaults, min: true }) } };",
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.snapshotFormat).toStrictEqual({ min: true });
		});

		it("should pass an object rather than an array to object merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				"export default { test: { snapshotFormat: defaults => ({ indent: Array.isArray(defaults) ? 99 : 2 }) } };",
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.snapshotFormat).toStrictEqual({ indent: 2 });
		});

		it("should reject function values for non-mergeable keys", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(configPath, 'export default { backend: () => "studio" };');

			await expect(loadConfig({ configPath, cwd: temporaryDirectory })).rejects.toThrow(
				"Invalid config",
			);
		});

		it("should pass empty defaults to standalone root-level merger functions", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(
				configPath,
				'export default { luauRoots: defaults => [...defaults, "child-out"] };',
			);

			const result = await loadConfig({ configPath, cwd: temporaryDirectory });

			expect(result.luauRoots).toStrictEqual(["child-out"]);
		});
	});

	describe("extends across directories", () => {
		it("should resolve parent in workspace root from child in nested subdirectory", async () => {
			expect.assertions(2);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ cwd: childDirectory });

			expect(result.timeout).toBe(12345);
			expect(result.verbose).toBeTrue();
		});

		it("should resolve extends against config file dir, not process.cwd()", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
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

			vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir());

			const result = await loadConfig({ cwd: childDirectory });

			expect(result.timeout).toBe(54321);
		});

		it("should resolve nested extends chain across directories", async () => {
			expect.assertions(3);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ cwd: childDirectory });

			expect(result.backend).toBe("open-cloud");
			expect(result.timeout).toBe(9999);
			expect(result.verbose).toBeTrue();
		});

		it("should load diamond extends with shared base ancestor", async () => {
			expect.assertions(3);

			const temporaryDirectory = makeTemporaryDirectory();
			fs.writeFileSync(path.join(temporaryDirectory, "leaf.mjs"), "export default {};");
			fs.writeFileSync(
				path.join(temporaryDirectory, "base.mjs"),
				'export default { extends: "./leaf.mjs", backend: "open-cloud" };',
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

			const result = await loadConfig({ cwd: temporaryDirectory });

			expect(result.backend).toBe("open-cloud");
			expect(result.timeout).toBe(1111);
			expect(result.verbose).toBeTrue();
		});

		it("should resolve absolute extends path verbatim", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const parentPath = path.join(temporaryDirectory, "jest.shared.mjs");
			fs.writeFileSync(parentPath, "export default { timeout: 2222 };");

			const childDirectory = path.join(temporaryDirectory, "deep", "nested");
			fs.mkdirSync(childDirectory, { recursive: true });
			fs.writeFileSync(
				path.join(childDirectory, "jest.config.mjs"),
				`export default { extends: ${JSON.stringify(parentPath)} };`,
			);

			const result = await loadConfig({ cwd: childDirectory });

			expect(result.timeout).toBe(2222);
		});

		it("should detect true cycle in extends chain", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const firstPath = path.join(temporaryDirectory, "a.mjs");
			const secondPath = path.join(temporaryDirectory, "b.mjs");
			fs.writeFileSync(firstPath, 'export default { extends: "./b.mjs" };');
			fs.writeFileSync(secondPath, 'export default { extends: "./a.mjs" };');

			await expect(
				loadConfig({ configPath: firstPath, cwd: temporaryDirectory }),
			).rejects.toThrowWithMessage(
				Error,
				`Circular extends detected: ${firstPath} -> ${secondPath} -> ${firstPath}.`,
			);
		});

		// cspell:disable-next-line
		it("should resolve extensionless extends via c12 extension search", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				"export default { timeout: 7777 };",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(childPath, 'export default { extends: "./jest.shared" };');

			const result = await loadConfig({ configPath: childPath, cwd: temporaryDirectory });

			expect(result.timeout).toBe(7777);
		});

		it("should surface parent parse errors with extends context, not as 'not found'", async () => {
			expect.assertions(4);

			const temporaryDirectory = makeTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.shared.mjs"),
				"export default {{{",
			);

			const childPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(childPath, 'export default { extends: "./jest.shared.mjs" };');

			const error = await loadConfig({
				configPath: childPath,
				cwd: temporaryDirectory,
			}).catch((err) => err);

			assert(error instanceof Error);

			const { message } = error;

			expect(message).toContain("Failed to resolve extends");
			expect(message).not.toContain("Config file not found");
			expect(message).toMatch(/jest\.shared\.mjs/);
			expect(error.cause).toBeInstanceOf(Error);
		});

		it("should surface explicit-path parse errors without wrapping as 'not found'", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const configPath = path.join(temporaryDirectory, "jest.config.mjs");
			fs.writeFileSync(configPath, "export default {{{");

			const error = await loadConfig({ configPath, cwd: temporaryDirectory }).catch(
				(err) => err,
			);

			assert(error instanceof Error);

			expect(error.message).not.toContain("Config file not found");
		});

		it("should anchor a relative workspace.root to the declaring shared config dir", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
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

			const result = await loadConfig({ cwd: childDirectory });

			expect(result.workspace!.root).toBe(temporaryDirectory);
		});

		it("should anchor a relative workspace.root declared without extends", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.config.mjs"),
				'export default { workspace: { packages: ["packages/*"], root: "." } };',
			);

			const result = await loadConfig({ cwd: temporaryDirectory });

			expect(result.workspace!.root).toBe(temporaryDirectory);
		});

		it("should leave an absolute workspace.root untouched", async () => {
			expect.assertions(1);

			const temporaryDirectory = makeTemporaryDirectory();
			const absoluteRoot = path.resolve(temporaryDirectory, "elsewhere");
			fs.writeFileSync(
				path.join(temporaryDirectory, "jest.config.mjs"),
				`export default { workspace: { packages: ["packages/*"], root: ${JSON.stringify(absoluteRoot)} } };`,
			);

			const result = await loadConfig({ cwd: temporaryDirectory });

			expect(result.workspace!.root).toBe(absoluteRoot);
		});
	});

	it("should forward non-extend warnings to console.warn", async () => {
		expect.assertions(1);

		const warnings: Array<string> = [];
		const originalWarn = console.warn;

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");

		fs.writeFileSync(
			configPath,
			'console.warn("some other warning"); export default { test: { verbose: true } };',
		);

		console.warn = (...args: Array<unknown>) => {
			warnings.push(args.join(" "));
		};

		try {
			await loadConfig({ configPath, cwd: temporaryDirectory });
		} finally {
			console.warn = originalWarn;
		}

		expect(warnings).toContain("some other warning");
	});

	it("should load JSON config in SEA mode", async () => {
		expect.assertions(2);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.json");
		fs.writeFileSync(configPath, JSON.stringify({ test: { verbose: true } }));

		const first = await loadConfig({ configPath, cwd: temporaryDirectory });
		fs.writeFileSync(configPath, JSON.stringify({ test: { verbose: false } }));
		const second = await loadConfig({ configPath, cwd: temporaryDirectory });

		expect(first.verbose).toBeTrue();
		expect(second.verbose).toBeFalse();
	});

	it("should load ESM config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(configPath, "export default { test: { verbose: true } };");

		const result = await loadConfig({ configPath, cwd: temporaryDirectory });

		expect(result.verbose).toBeTrue();
	});

	it("should load TypeScript config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.ts");
		fs.writeFileSync(
			configPath,
			"type C = { test?: { verbose?: boolean } };\n" +
				"export default { test: { verbose: true } } satisfies C;\n",
		);

		const result = await loadConfig({ configPath, cwd: temporaryDirectory });

		expect(result.verbose).toBeTrue();
	});

	it("should load ESM TypeScript (.mts) config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mts");
		fs.writeFileSync(
			configPath,
			"type C = { test?: { verbose?: boolean } };\n" +
				"export default { test: { verbose: true } } satisfies C;\n",
		);

		const result = await loadConfig({ configPath, cwd: temporaryDirectory });

		expect(result.verbose).toBeTrue();
	});

	it("should load CommonJS TypeScript (.cts) config in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.cts");

		fs.writeFileSync(
			configPath,
			"interface C { test?: { verbose?: boolean } }\n" +
				"const config: C = { test: { verbose: true } };\n" +
				"module.exports = config;\n",
		);

		const result = await loadConfig({ configPath, cwd: temporaryDirectory });

		expect(result.verbose).toBeTrue();
	});

	it("should throw with clear message when extends target is missing", async () => {
		expect.assertions(1);

		const temporaryDirectory = makeTemporaryDirectory();
		const configPath = path.join(temporaryDirectory, "jest.config.mjs");
		fs.writeFileSync(
			configPath,
			'export default { extends: "./does-not-exist.mjs", test: { verbose: true } };',
		);

		await expect(
			loadConfig({ configPath, cwd: temporaryDirectory }),
		).rejects.toThrowWithMessage(Error, /Failed to resolve extends.*does-not-exist\.mjs/);
	});
});
