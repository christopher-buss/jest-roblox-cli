// cspell:words bakcend
import { type } from "arktype";
import { describe, expect, it } from "vitest";

import {
	configSchema,
	defineConfig,
	defineProject,
	isValidBackend,
	ROOT_ONLY_KEYS,
	validateConfig,
} from "./schema.ts";

describe(defineConfig, () => {
	it("should return the config object unchanged", () => {
		expect.assertions(1);

		const config = { backend: "studio" as const, verbose: true };

		expect(defineConfig(config)).toBe(config);
	});

	it("should return an empty config unchanged", () => {
		expect.assertions(1);

		const config = {};

		expect(defineConfig(config)).toBe(config);
	});
});

describe(isValidBackend, () => {
	it("should return true for valid backends", () => {
		expect.assertions(3);

		expect(isValidBackend("auto")).toBeTrue();
		expect(isValidBackend("open-cloud")).toBeTrue();
		expect(isValidBackend("studio")).toBeTrue();
	});

	it("should return false for invalid backends", () => {
		expect.assertions(2);

		expect(isValidBackend("invalid")).toBeFalse();
		expect(isValidBackend("")).toBeFalse();
	});
});

describe("rOOT_ONLY_KEYS", () => {
	it("should contain backend", () => {
		expect.assertions(1);

		expect(ROOT_ONLY_KEYS.has("backend")).toBeTrue();
	});

	it("should contain all root-only keys", () => {
		expect.assertions(23);

		const expected = [
			"backend",
			"cache",
			"collectCoverage",
			"collectCoverageFrom",
			"coverageDirectory",
			"coveragePathIgnorePatterns",
			"coverageReporters",
			"coverageThreshold",
			"formatters",
			"gameOutput",
			"jestPath",
			"luauRoots",
			"placeFile",
			"pollInterval",
			"port",
			"rojoProject",
			"rootDir",
			"showLuau",
			"sourceMap",
			"timeout",
			"typecheck",
			"typecheckOnly",
			"typecheckTsconfig",
		];

		for (const key of expected) {
			expect(ROOT_ONLY_KEYS.has(key)).toBeTrue();
		}
	});

	it("should not contain project-level keys", () => {
		expect.assertions(4);

		expect(ROOT_ONLY_KEYS.has("testMatch")).toBeFalse();
		expect(ROOT_ONLY_KEYS.has("clearMocks")).toBeFalse();
		expect(ROOT_ONLY_KEYS.has("displayName")).toBeFalse();
		expect(ROOT_ONLY_KEYS.has("setupFiles")).toBeFalse();
	});
});

describe(defineProject, () => {
	it("should return the project config unchanged", () => {
		expect.assertions(1);

		const config = { displayName: "client", include: ["src/client"] };

		expect(defineProject(config)).toBe(config);
	});

	it("should accept displayName as string", () => {
		expect.assertions(1);

		const config = { displayName: "server", include: ["src/server"] };
		const result = defineProject(config);

		expect(result.displayName).toBe("server");
	});

	it("should accept displayName as object with name and color", () => {
		expect.assertions(1);

		const config = {
			displayName: { name: "shared", color: "blue" },
			include: ["src/shared"],
		};
		const result = defineProject(config);

		expect(result.displayName).toStrictEqual({ name: "shared", color: "blue" });
	});
});

describe(configSchema, () => {
	describe("valid configs", () => {
		it("should accept an empty config", () => {
			expect.assertions(1);

			const result = configSchema({});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept a config with only jest-roblox keys", () => {
			expect.assertions(1);

			const result = configSchema({
				backend: "studio",
				cache: false,
				collectCoverage: true,
				coverageDirectory: "my-cov",
				port: 4000,
				timeout: 60_000,
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept all valid backend values", () => {
			expect.assertions(3);

			for (const backend of ["auto", "open-cloud", "studio"]) {
				expect(configSchema({ backend })).not.toBeInstanceOf(type.errors);
			}
		});

		it("should accept valid argv keys", () => {
			expect.assertions(1);

			const result = configSchema({
				automock: true,
				clearMocks: false,
				silent: true,
				testMatch: ["**/*.spec.ts"],
				verbose: false,
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid projects as string array", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: ["src/client", "src/server"],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid inline project entries", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [
					{
						test: {
							displayName: "client",
							include: ["src/client/**/*.spec.ts"],
						},
					},
				],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept mixed project entries", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [
					"src/shared",
					{
						test: {
							displayName: "server",
							include: ["src/server"],
						},
					},
				],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid coverageThreshold", () => {
			expect.assertions(1);

			const result = configSchema({
				coverageThreshold: {
					branches: 80,
					functions: 90,
					lines: 95,
					statements: 95,
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid snapshotFormat", () => {
			expect.assertions(1);

			const result = configSchema({
				snapshotFormat: {
					indent: 4,
					min: true,
					printBasicPrototype: false,
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept formatter as string array", () => {
			expect.assertions(1);

			const result = configSchema({
				formatters: ["default", "github-actions"],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept formatter as tuple with options", () => {
			expect.assertions(1);

			const result = configSchema({
				formatters: ["default", ["github-actions", { annotations: true }]],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept displayName as object in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [
					{
						test: {
							displayName: { name: "client", color: "cyan" },
							include: ["src/client"],
						},
					},
				],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept root field in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [
					{
						test: {
							displayName: "client",
							include: ["src/**/*.spec.ts"],
							root: "packages/core",
						},
					},
				],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept outDir field in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [
					{
						test: {
							displayName: "core",
							include: ["src/**/*.spec.ts"],
							outDir: "out-test/src",
						},
					},
				],
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testRegex as string", () => {
			expect.assertions(1);

			const result = configSchema({ testRegex: ".*\\.spec\\.ts$" });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testRegex as string array", () => {
			expect.assertions(1);

			const result = configSchema({ testRegex: [".*\\.spec\\.ts$", ".*\\.test\\.ts$"] });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept bail as boolean", () => {
			expect.assertions(1);

			const result = configSchema({ bail: true });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept bail as number", () => {
			expect.assertions(1);

			const result = configSchema({ bail: 3 });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept maxWorkers as number", () => {
			expect.assertions(1);

			const result = configSchema({ maxWorkers: 4 });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept maxWorkers as string", () => {
			expect.assertions(1);

			const result = configSchema({ maxWorkers: "50%" });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testEnvironmentOptions as string", () => {
			expect.assertions(1);

			const result = configSchema({ testEnvironmentOptions: "{}" });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept passWithNoTests", () => {
			expect.assertions(1);

			const result = configSchema({ passWithNoTests: true });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testEnvironmentOptions as object", () => {
			expect.assertions(1);

			const result = configSchema({
				testEnvironmentOptions: { url: "http://localhost" },
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});
	});

	describe("invalid configs", () => {
		it("should reject invalid backend value", () => {
			expect.assertions(1);

			const result = configSchema({ backend: "not-a-backend" });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject backend with wrong type", () => {
			expect.assertions(1);

			const result = configSchema({ backend: 123 });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject port with wrong type", () => {
			expect.assertions(1);

			const result = configSchema({ port: "abc" });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject timeout with wrong type", () => {
			expect.assertions(1);

			const result = configSchema({ timeout: "slow" });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject testMatch with wrong type", () => {
			expect.assertions(1);

			const result = configSchema({ testMatch: "not-an-array" });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject coverageThreshold with string values", () => {
			expect.assertions(1);

			const result = configSchema({
				coverageThreshold: { lines: "high" },
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject snapshotFormat with wrong indent type", () => {
			expect.assertions(1);

			const result = configSchema({
				snapshotFormat: { indent: "four" },
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject undeclared keys (typos)", () => {
			expect.assertions(1);

			const result = configSchema({ bakcend: "studio" });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject verbose with wrong type", () => {
			expect.assertions(1);

			const result = configSchema({ verbose: "yes" });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject projects with wrong element type", () => {
			expect.assertions(1);

			const result = configSchema({ projects: [123] });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject inline project missing required include", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [{ test: { displayName: "bad" } }],
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject inline project missing required displayName", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [{ test: { include: ["src/**/*.spec.ts"] } }],
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject tsconfig field in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				projects: [
					{
						test: {
							displayName: "core",
							include: ["src/**/*.spec.ts"],
							tsconfig: "tsconfig.spec.json",
						},
					},
				],
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject formatters with wrong element type", () => {
			expect.assertions(1);

			const result = configSchema({ formatters: [123] });

			expect(result).toBeInstanceOf(type.errors);
		});
	});

	describe("error messages", () => {
		it("should produce readable error for invalid backend", () => {
			expect.assertions(2);

			const result = configSchema({ backend: "bad" });

			expect(result).toBeInstanceOf(type.errors);
			expect((result as type.errors).summary).toMatchInlineSnapshot(
				'"backend must be "auto", "open-cloud" or "studio" (was "bad")"',
			);
		});

		it("should produce readable error for wrong type", () => {
			expect.assertions(2);

			const result = configSchema({ port: "not-a-number" });

			expect(result).toBeInstanceOf(type.errors);
			expect((result as type.errors).summary).toMatchInlineSnapshot(
				'"port must be a number (was a string)"',
			);
		});

		it("should produce readable error for undeclared key", () => {
			expect.assertions(2);

			const result = configSchema({ bakcend: "studio" });

			expect(result).toBeInstanceOf(type.errors);
			expect((result as type.errors).summary).toMatchInlineSnapshot(
				'"bakcend must be removed"',
			);
		});

		it("should produce readable error for nested validation", () => {
			expect.assertions(2);

			const result = configSchema({
				coverageThreshold: { lines: "high" },
			});

			expect(result).toBeInstanceOf(type.errors);
			expect((result as type.errors).summary).toMatchInlineSnapshot(
				'"coverageThreshold.lines must be a number (was a string)"',
			);
		});
	});
});

describe(validateConfig, () => {
	it("should return the config when valid", () => {
		expect.assertions(1);

		const input = { backend: "studio", verbose: true };

		expect(validateConfig(input)).toStrictEqual(input);
	});

	it("should throw on invalid config", () => {
		expect.assertions(1);

		expect(() => validateConfig({ port: "abc" })).toThrow("Invalid config");
	});

	it("should include arktype summary in error message", () => {
		expect.assertions(1);

		expect(() => validateConfig({ backend: 123 })).toThrow(/must be/);
	});
});
