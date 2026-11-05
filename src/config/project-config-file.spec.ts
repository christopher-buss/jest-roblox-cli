// cspell:words includ

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createProjectSeams } from "#test/mocks/spec-project-seams.ts";
import type { ProjectConfigInput } from "./project-config-file.ts";
import { loadProjectConfigFile } from "./project-config-file.ts";

function seedLuauProjectConfig({
	cwd = "/project",
	directoryOrFile,
	source,
}: {
	readonly cwd?: string;
	readonly directoryOrFile: string;
	readonly source: string;
}): ProjectConfigInput {
	const { fileSystem } = createMemoryFileSystem({
		[path.resolve(cwd, directoryOrFile, "jest.config.luau")]: source,
	});

	return { fileSystem };
}

describe(loadProjectConfigFile, () => {
	it("should load and return project config via c12", async () => {
		expect.assertions(3);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./client.config.ts",
			input: seams,
		});

		expect(result.displayName).toBe("client");
		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
		expect(configLoader).toHaveBeenCalledExactlyOnceWith({
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

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
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

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./client.config.ts",
			input: seams,
		});

		expect(result.displayName).toBe("client");
		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});

	it("should throw when config file not found", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockRejectedValueOnce(new Error("File not found"));

		await expect(
			loadProjectConfigFile({
				cwd: "/project",
				filePath: "./missing.config.ts",
				input: seams,
			}),
		).rejects.toThrow("Failed to load project config file ./missing.config.ts: File not found");
	});

	it("should stringify non-Error thrown values", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockRejectedValueOnce("raw string rejection");

		await expect(
			loadProjectConfigFile({ cwd: "/project", filePath: "./bad.config.ts", input: seams }),
		).rejects.toThrow(
			"Failed to load project config file ./bad.config.ts: raw string rejection",
		);
	});

	it("should preserve original error message for non-ENOENT errors", async () => {
		expect.assertions(3);

		const { configLoader, seams } = createProjectSeams();
		const cause = new Error("Syntax error in config");
		configLoader.mockRejectedValueOnce(cause);

		const promise = loadProjectConfigFile({
			cwd: "/project",
			filePath: "./broken.config.ts",
			input: seams,
		});

		await expect(promise).rejects.toThrow(
			"Failed to load project config file ./broken.config.ts: Syntax error in config",
		);
		await expect(promise).rejects.toHaveProperty("cause", cause);
		expect(configLoader).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ configFile: "./broken.config.ts", cwd: "/project" }),
		);
	});

	it("should extract displayName from object-style displayName", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: { name: "client", color: "cyan" },
				include: ["src/client/**/*.spec.ts"],
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./client.config.ts",
			input: seams,
		});

		expect(result.displayName).toStrictEqual({ name: "client", color: "cyan" });
	});

	it("should throw when config has no displayName", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "",
				include: ["src/**/*.spec.ts"],
			},
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(
			loadProjectConfigFile({
				cwd: "/project",
				filePath: "./no-name.config.ts",
				input: seams,
			}),
		).rejects.toThrow('Project config file "./no-name.config.ts" must have a displayName');
	});

	it("should throw when config omits displayName entirely", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: { include: ["src/**/*.spec.ts"] },
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(
			loadProjectConfigFile({
				cwd: "/project",
				filePath: "./no-name.config.ts",
				input: seams,
			}),
		).rejects.toThrow(/Invalid project config file "\.\/no-name\.config\.ts"/);
	});

	it("should reject an unknown key in a project config file", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: { displayName: "client", includ: ["src/**/*.spec.ts"] },
			configFile: "jest-project.config.ts",
			cwd: "/project",
			layers: [],
		});

		await expect(
			loadProjectConfigFile({ cwd: "/project", filePath: "./typo.config.ts", input: seams }),
		).rejects.toThrow(/Invalid project config file "\.\/typo\.config\.ts".*includ/);
	});

	it("should derive include from testMatch when include is missing", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "shared",
				testMatch: ["**/__tests__/**/*.test"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./shared/jest.config.ts",
			input: seams,
		});

		expect(result.include).toStrictEqual([
			"shared/**/__tests__/**/*.test.ts",
			"shared/**/__tests__/**/*.test.tsx",
		]);
	});

	it("should leave include undefined when neither include nor testMatch is set", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "minimal",
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./minimal.config.ts",
			input: seams,
		});

		expect(result).not.toHaveProperty("include");
	});

	it("should derive outDir from config path for roblox-ts projects", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "shared",
				testMatch: ["**/__tests__/**/*.test"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "src/shared/jest.config.ts",
			input: seams,
		});

		expect(result.outDir).toBe("out/shared");
	});

	it("should not derive outDir when tsconfig has no rootDir/outDir", async () => {
		expect.assertions(1);

		const { configLoader, resolveTsconfigDirectories, seams } = createProjectSeams();
		resolveTsconfigDirectories.mockReturnValueOnce({
			outDir: undefined,
			rootDir: undefined,
		});
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "luau-only",
				testMatch: ["**/*.spec"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "src/shared/jest.config.ts",
			input: seams,
		});

		expect(result.outDir).toBeUndefined();
	});

	it.for([
		{ outDir: "out", rootDir: undefined },
		{ outDir: undefined, rootDir: "src" },
	])(
		"should not derive outDir when only one tsconfig directory is available",
		async (directories) => {
			expect.assertions(1);

			const { configLoader, resolveTsconfigDirectories, seams } = createProjectSeams();
			resolveTsconfigDirectories.mockReturnValueOnce(directories);
			configLoader.mockResolvedValueOnce({
				config: { displayName: "partial", testMatch: ["**/*.spec"] },
				configFile: "jest.config.ts",
				cwd: "/project",
				layers: [],
			});

			const result = await loadProjectConfigFile({
				cwd: "/project",
				filePath: "src/shared/jest.config.ts",
				input: seams,
			});

			expect(result).not.toHaveProperty("outDir");
		},
	);

	it("should not infer a missing rootDir from a literal undefined directory", async () => {
		expect.assertions(1);

		const { configLoader, resolveTsconfigDirectories, seams } = createProjectSeams();
		resolveTsconfigDirectories.mockReturnValueOnce({ outDir: "out", rootDir: undefined });
		configLoader.mockResolvedValueOnce({
			config: { displayName: "partial", testMatch: ["**/*.spec"] },
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "undefined/shared/jest.config.ts",
			input: seams,
		});

		expect(result).not.toHaveProperty("outDir");
	});

	it("should preserve an explicit outDir when tsconfig directories are available", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: { displayName: "custom", outDir: "custom-output", testMatch: ["**/*.spec"] },
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "src/shared/jest.config.ts",
			input: seams,
		});

		expect(result.outDir).toBe("custom-output");
	});

	it("should not derive outDir when config path is not under src/", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "lib",
				testMatch: ["**/*.spec"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "packages/lib/jest.config.ts",
			input: seams,
		});

		expect(result.outDir).toBeUndefined();
	});

	it("should keep testMatch patterns that already have source extensions", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "mixed",
				testMatch: ["**/*.spec.ts", "**/*.test"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./shared/mixed.config.ts",
			input: seams,
		});

		expect(result.include).toStrictEqual([
			"shared/**/*.spec.ts",
			"shared/**/*.test.ts",
			"shared/**/*.test.tsx",
		]);
	});

	it("should keep Lua and Luau testMatch extensions without adding TypeScript variants", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "luau",
				testMatch: ["**/*.spec.lua", "**/*.test.luau"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./shared/luau.config.ts",
			input: seams,
		});

		expect(result.include).toStrictEqual(["shared/**/*.spec.lua", "shared/**/*.test.luau"]);
	});

	it("should only recognize source extensions at the end of a testMatch pattern", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "suffix",
				testMatch: ["**/*.spec.ts.fixture"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./shared/suffix.config.ts",
			input: seams,
		});

		expect(result.include).toStrictEqual([
			"shared/**/*.spec.ts.fixture.ts",
			"shared/**/*.spec.ts.fixture.tsx",
		]);
	});

	it("should not override include when already provided", async () => {
		expect.assertions(1);

		const { configLoader, seams } = createProjectSeams();
		configLoader.mockResolvedValueOnce({
			config: {
				displayName: "client",
				include: ["src/client/**/*.spec.ts"],
				testMatch: ["**/*.spec"],
			},
			configFile: "jest.config.ts",
			cwd: "/project",
			layers: [],
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "./client.config.ts",
			input: seams,
		});

		expect(result.include).toStrictEqual(["src/client/**/*.spec.ts"]);
	});

	it("should load Luau config when jest.config.luau exists", async () => {
		expect.assertions(2);

		const input = seedLuauProjectConfig({
			directoryOrFile: "packages/shared",
			source: 'return { displayName = "shared-luau", testMatch = { "**/*.spec" } }',
		});

		const result = await loadProjectConfigFile({
			cwd: "/project",
			filePath: "packages/shared",
			input,
		});

		expect(result.displayName).toBe("shared-luau");
		expect(result.include).toContain("packages/shared/**/*.spec.luau");
	});

	it("should throw when Luau config has empty displayName", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "lib",
			source: 'return { displayName = "" }',
		});

		await expect(
			loadProjectConfigFile({ cwd: "/project", filePath: "lib", input }),
		).rejects.toThrowWithMessage(Error, /must have a displayName string/);
	});

	it("should throw when Luau config has no displayName", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({ directoryOrFile: "lib", source: "return {}" });

		await expect(
			loadProjectConfigFile({ cwd: "/project", filePath: "lib", input }),
		).rejects.toThrowWithMessage(Error, /must have a displayName string/);
	});

	it("should derive default include pattern when Luau config has no testMatch", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: 'return { displayName = "shared" }',
		});

		const result = await loadProjectConfigFile({ cwd: "/project", filePath: "shared", input });

		expect(result.include).toStrictEqual(["shared/**/*.spec.luau"]);
	});

	it("should set testMatch on config when Luau config provides testMatch", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: 'return { displayName = "shared", testMatch = { "**/*.spec", "**/*.test" } }',
		});

		const result = await loadProjectConfigFile({ cwd: "/project", filePath: "shared", input });

		expect(result.testMatch).toStrictEqual(["**/*.spec", "**/*.test"]);
	});

	it("should copy boolean optional fields from Luau config", async () => {
		expect.assertions(2);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: 'return { clearMocks = true, displayName = "shared", resetMocks = false }',
		});

		const result = await loadProjectConfigFile({ cwd: "/project", filePath: "shared", input });

		expect(result.clearMocks).toBeTrue();
		expect(result.resetMocks).toBeFalse();
	});

	it("should copy number optional fields from Luau config", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: 'return { displayName = "shared", testTimeout = 5000 }',
		});

		const result = await loadProjectConfigFile({ cwd: "/project", filePath: "shared", input });

		expect(result.testTimeout).toBe(5000);
	});

	it("should copy string optional fields from Luau config", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: 'return { displayName = "shared", testEnvironment = "jest-environment-jsdom" }',
		});

		const result = await loadProjectConfigFile({ cwd: "/project", filePath: "shared", input });

		expect(result.testEnvironment).toBe("jest-environment-jsdom");
	});

	it("should copy string array optional fields from Luau config", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: 'return { displayName = "shared", setupFiles = { "setup.luau" } }',
		});

		const result = await loadProjectConfigFile({ cwd: "/project", filePath: "shared", input });

		expect(result.setupFiles).toStrictEqual(["setup.luau"]);
	});

	it("should reject fields with wrong types in Luau config", async () => {
		expect.assertions(1);

		const input = seedLuauProjectConfig({
			directoryOrFile: "shared",
			source: [
				'return { clearMocks = "yes", displayName = "shared",',
				'setupFiles = "not-an-array", testTimeout = "fast" }',
			].join(" "),
		});

		await expect(
			loadProjectConfigFile({ cwd: "/project", filePath: "shared", input }),
		).rejects.toThrow(
			/clearMocks must be boolean.*setupFiles must be an array.*testTimeout must be a number/s,
		);
	});
});
