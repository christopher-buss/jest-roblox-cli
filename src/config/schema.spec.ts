// cspell:words bakcend
import { type } from "arktype";
import { describe, expect, it } from "vitest";

import {
	configSchema,
	defineConfig,
	defineProject,
	GLOBAL_TEST_KEYS,
	isValidBackend,
	PROJECT_TEST_KEYS,
	ROOT_CLI_KEYS,
	ROOT_CLI_KEYS_LIST,
	SHARED_TEST_KEYS,
	validateConfig,
} from "./schema.ts";

describe(defineConfig, () => {
	it("should return the config object unchanged", () => {
		expect.assertions(1);

		const config = { backend: "studio" as const, test: { verbose: true } };

		expect(defineConfig(config)).toBe(config);
	});

	it("should return an empty config unchanged", () => {
		expect.assertions(1);

		const config = {};

		expect(defineConfig(config)).toBe(config);
	});

	it("should accept merger functions for test.* array fields", () => {
		expect.assertions(1);

		const config = defineConfig({
			test: {
				setupFiles: (defaults) => {
					return [...defaults, "extra.luau"];
				},
			},
		});

		expect(config.test?.setupFiles).toBeFunction();
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

describe("rOOT_CLI_KEYS", () => {
	it("should contain backend", () => {
		expect.assertions(1);

		expect(ROOT_CLI_KEYS.has("backend")).toBeTrue();
	});

	it("should contain exactly the CLI/runner key list", () => {
		expect.assertions(1);

		expect([...ROOT_CLI_KEYS].sort()).toStrictEqual([...ROOT_CLI_KEYS_LIST].sort());
	});

	it("should not contain shared jest passthrough keys", () => {
		expect.assertions(3);

		expect(ROOT_CLI_KEYS.has("testMatch")).toBeFalse();
		expect(ROOT_CLI_KEYS.has("clearMocks")).toBeFalse();
		expect(ROOT_CLI_KEYS.has("setupFiles")).toBeFalse();
	});

	it("should not contain global-only jest passthrough keys", () => {
		expect.assertions(3);

		expect(ROOT_CLI_KEYS.has("coverageThreshold")).toBeFalse();
		expect(ROOT_CLI_KEYS.has("collectCoverage")).toBeFalse();
		expect(ROOT_CLI_KEYS.has("verbose")).toBeFalse();
	});
});

describe("gLOBAL_TEST_KEYS", () => {
	it("should contain coverage keys (global-only)", () => {
		expect.assertions(5);

		expect(GLOBAL_TEST_KEYS.has("collectCoverage")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("coverageDirectory")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("coverageThreshold")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("collectCoverageFrom")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("coverageReporters")).toBeTrue();
	});

	it("should contain runner-level keys (global-only)", () => {
		expect.assertions(4);

		expect(GLOBAL_TEST_KEYS.has("verbose")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("silent")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("bail")).toBeTrue();
		expect(GLOBAL_TEST_KEYS.has("projects")).toBeTrue();
	});

	it("should not contain shared keys (which are valid both globally and per-project)", () => {
		expect.assertions(4);

		expect(GLOBAL_TEST_KEYS.has("setupFiles")).toBeFalse();
		expect(GLOBAL_TEST_KEYS.has("testMatch")).toBeFalse();
		expect(GLOBAL_TEST_KEYS.has("clearMocks")).toBeFalse();
		expect(GLOBAL_TEST_KEYS.has("testTimeout")).toBeFalse();
	});

	it("should not contain CLI keys", () => {
		expect.assertions(4);

		expect(GLOBAL_TEST_KEYS.has("backend")).toBeFalse();
		expect(GLOBAL_TEST_KEYS.has("outputFile")).toBeFalse();
		expect(GLOBAL_TEST_KEYS.has("port")).toBeFalse();
		expect(GLOBAL_TEST_KEYS.has("rojoProject")).toBeFalse();
	});
});

describe("sHARED_TEST_KEYS", () => {
	it("should contain keys valid both at test: and per-project", () => {
		expect.assertions(4);

		expect(SHARED_TEST_KEYS.has("setupFiles")).toBeTrue();
		expect(SHARED_TEST_KEYS.has("testMatch")).toBeTrue();
		expect(SHARED_TEST_KEYS.has("clearMocks")).toBeTrue();
		expect(SHARED_TEST_KEYS.has("testTimeout")).toBeTrue();
	});

	it("should not contain global-only or CLI keys", () => {
		expect.assertions(3);

		expect(SHARED_TEST_KEYS.has("verbose")).toBeFalse();
		expect(SHARED_TEST_KEYS.has("collectCoverage")).toBeFalse();
		expect(SHARED_TEST_KEYS.has("backend")).toBeFalse();
	});
});

describe("pROJECT_TEST_KEYS", () => {
	it("should contain shared jest-passthrough keys", () => {
		expect.assertions(4);

		expect(PROJECT_TEST_KEYS.has("setupFiles")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("testMatch")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("clearMocks")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("testTimeout")).toBeTrue();
	});

	it("should contain project-only keys", () => {
		expect.assertions(5);

		expect(PROJECT_TEST_KEYS.has("displayName")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("include")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("exclude")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("outDir")).toBeTrue();
		expect(PROJECT_TEST_KEYS.has("root")).toBeTrue();
	});

	it("should not contain global-only test keys", () => {
		expect.assertions(5);

		expect(PROJECT_TEST_KEYS.has("verbose")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("silent")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("passWithNoTests")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("bail")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("collectCoverage")).toBeFalse();
	});

	it("should not contain root CLI keys", () => {
		expect.assertions(4);

		expect(PROJECT_TEST_KEYS.has("backend")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("outputFile")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("port")).toBeFalse();
		expect(PROJECT_TEST_KEYS.has("rojoProject")).toBeFalse();
	});
});

describe(defineProject, () => {
	it("should return the project config unchanged", () => {
		expect.assertions(1);

		const config = { test: { displayName: "client", include: ["src/client"] } };

		expect(defineProject(config)).toBe(config);
	});

	it("should accept displayName as string", () => {
		expect.assertions(1);

		const config = { test: { displayName: "server", include: ["src/server"] } };
		const result = defineProject(config);

		expect(result.test.displayName).toBe("server");
	});

	it("should accept displayName as object with name and color", () => {
		expect.assertions(1);

		const config = {
			test: {
				displayName: { name: "shared", color: "blue" },
				include: ["src/shared"],
			},
		};
		const result = defineProject(config);

		expect(result.test.displayName).toStrictEqual({ name: "shared", color: "blue" });
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
				coverageCache: false,
				port: 4000,
				test: {
					collectCoverage: true,
					coverageDirectory: "my-cov",
				},
				timeout: 60_000,
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should reject the removed `cache` field as unknown", () => {
			expect.assertions(1);

			expect(() => validateConfig({ cache: true })).toThrow(/Invalid config/);
		});

		it("should accept all valid backend values", () => {
			expect.assertions(3);

			for (const backend of ["auto", "open-cloud", "studio"]) {
				expect(configSchema({ backend })).not.toBeInstanceOf(type.errors);
			}
		});

		it("should accept valid jest passthrough keys under test:", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					automock: true,
					clearMocks: false,
					silent: true,
					testMatch: ["**/*.spec.ts"],
					verbose: false,
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid projects as string array", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					projects: ["src/client", "src/server"],
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid inline project entries", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					projects: [
						{
							test: {
								displayName: "client",
								include: ["src/client/**/*.spec.ts"],
							},
						},
					],
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept mixed project entries", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					projects: [
						"src/shared",
						{
							test: {
								displayName: "server",
								include: ["src/server"],
							},
						},
					],
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid coverageThreshold", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					coverageThreshold: {
						branches: 80,
						functions: 90,
						lines: 95,
						statements: 95,
					},
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept valid snapshotFormat", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					snapshotFormat: {
						indent: 4,
						min: true,
						printBasicPrototype: false,
					},
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
				test: {
					projects: [
						{
							test: {
								displayName: { name: "client", color: "cyan" },
								include: ["src/client"],
							},
						},
					],
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept root field in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					projects: [
						{
							test: {
								displayName: "client",
								include: ["src/**/*.spec.ts"],
								root: "packages/core",
							},
						},
					],
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept outDir field in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					projects: [
						{
							test: {
								displayName: "core",
								include: ["src/**/*.spec.ts"],
								outDir: "out-test/src",
							},
						},
					],
				},
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testRegex as string", () => {
			expect.assertions(1);

			const result = configSchema({ test: { testRegex: ".*\\.spec\\.ts$" } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testRegex as string array", () => {
			expect.assertions(1);

			const result = configSchema({
				test: { testRegex: [".*\\.spec\\.ts$", ".*\\.test\\.ts$"] },
			});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept bail as boolean", () => {
			expect.assertions(1);

			const result = configSchema({ test: { bail: true } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept bail as number", () => {
			expect.assertions(1);

			const result = configSchema({ test: { bail: 3 } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept maxWorkers as number", () => {
			expect.assertions(1);

			const result = configSchema({ test: { maxWorkers: 4 } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept maxWorkers as string", () => {
			expect.assertions(1);

			const result = configSchema({ test: { maxWorkers: "50%" } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testEnvironmentOptions as string", () => {
			expect.assertions(1);

			const result = configSchema({ test: { testEnvironmentOptions: "{}" } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept passWithNoTests", () => {
			expect.assertions(1);

			const result = configSchema({ test: { passWithNoTests: true } });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it('should accept parallel as "auto"', () => {
			expect.assertions(1);

			const result = configSchema({ parallel: "auto" });

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept parallel as integer >= 1", () => {
			expect.assertions(2);

			expect(configSchema({ parallel: 1 })).not.toBeInstanceOf(type.errors);
			expect(configSchema({ parallel: 3 })).not.toBeInstanceOf(type.errors);
		});

		it("should accept omitted parallel", () => {
			expect.assertions(1);

			const result = configSchema({});

			expect(result).not.toBeInstanceOf(type.errors);
		});

		it("should accept testEnvironmentOptions as object", () => {
			expect.assertions(1);

			const result = configSchema({
				test: { testEnvironmentOptions: { url: "http://localhost" } },
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

			const result = configSchema({ test: { testMatch: "not-an-array" } });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject coverageThreshold with string values", () => {
			expect.assertions(1);

			const result = configSchema({
				test: { coverageThreshold: { lines: "high" } },
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject snapshotFormat with wrong indent type", () => {
			expect.assertions(1);

			const result = configSchema({
				test: { snapshotFormat: { indent: "four" } },
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

			const result = configSchema({ test: { verbose: "yes" } });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject projects with wrong element type", () => {
			expect.assertions(1);

			const result = configSchema({ test: { projects: [123] } });

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject inline project missing required include", () => {
			expect.assertions(1);

			const result = configSchema({
				test: { projects: [{ test: { displayName: "bad" } }] },
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject inline project missing required displayName", () => {
			expect.assertions(1);

			const result = configSchema({
				test: { projects: [{ test: { include: ["src/**/*.spec.ts"] } }] },
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject tsconfig field in inline project", () => {
			expect.assertions(1);

			const result = configSchema({
				test: {
					projects: [
						{
							test: {
								displayName: "core",
								include: ["src/**/*.spec.ts"],
								tsconfig: "tsconfig.spec.json",
							},
						},
					],
				},
			});

			expect(result).toBeInstanceOf(type.errors);
		});

		it("should reject global-only key verbose inside an inline project", () => {
			expect.assertions(2);

			const result = configSchema({
				test: {
					projects: [
						{
							test: {
								displayName: "core",
								include: ["src/**/*.spec.ts"],
								verbose: true,
							},
						},
					],
				},
			});

			expect(result).toBeInstanceOf(type.errors);
			expect(String(result)).toContain("verbose");
		});

		it("should reject parallel: 0", () => {
			expect.assertions(1);

			expect(configSchema({ parallel: 0 })).toBeInstanceOf(type.errors);
		});

		it("should reject parallel with negative value", () => {
			expect.assertions(1);

			expect(configSchema({ parallel: -1 })).toBeInstanceOf(type.errors);
		});

		it("should reject parallel with non-integer value", () => {
			expect.assertions(1);

			expect(configSchema({ parallel: 2.5 })).toBeInstanceOf(type.errors);
		});

		it("should reject parallel with arbitrary string", () => {
			expect.assertions(1);

			expect(configSchema({ parallel: "invalid" })).toBeInstanceOf(type.errors);
		});

		it("should reject parallel with boolean value", () => {
			expect.assertions(1);

			expect(configSchema({ parallel: true })).toBeInstanceOf(type.errors);
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
				test: { coverageThreshold: { lines: "high" } },
			});

			expect(result).toBeInstanceOf(type.errors);
			expect((result as type.errors).summary).toMatchInlineSnapshot(
				'"test.coverageThreshold.lines must be a number (was a string)"',
			);
		});
	});
});

describe(validateConfig, () => {
	it("should return the config when valid", () => {
		expect.assertions(1);

		const input = { backend: "studio", test: { verbose: true } };

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

	it("should let arktype reject non-object input rather than scanning keys", () => {
		expect.assertions(1);

		expect(() => validateConfig(null)).toThrow(/Invalid config/);
	});

	it("should reject jest passthrough key at root with migration directive", () => {
		expect.assertions(1);

		expect(() => validateConfig({ setupFiles: ["./global.ts"] })).toThrow(
			"jest options must be wrapped in a `test:` block. Move these keys under `test:`: setupFiles",
		);
	});

	it("should accept jest passthrough keys nested under test:", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				test: { setupFiles: ["./global.ts"] },
			});
		}).not.toThrow();
	});

	it("should validate types inside test: block", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { setupFiles: 123 } })).toThrow(/setupFiles/);
	});

	it("should list all misplaced jest keys in a single grouped error", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				coverageThreshold: { lines: 80 },
				setupFiles: ["./global.ts"],
				testMatch: ["**/*.spec.ts"],
			});
		}).toThrow(
			"jest options must be wrapped in a `test:` block. Move these keys under `test:`: coverageThreshold, setupFiles, testMatch",
		);
	});

	it("should reject a flat root typecheck key with a migration directive", () => {
		expect.assertions(1);

		expect(() => validateConfig({ typecheck: true })).toThrow(
			"`typecheck` options have moved under `test.typecheck`. Replace these keys: typecheck → test.typecheck.enabled",
		);
	});

	it("should list all migrated typecheck keys with their targets", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				typecheck: true,
				typecheckOnly: true,
				typecheckTsconfig: "tsconfig.test.json",
			});
		}).toThrow(
			"`typecheck` options have moved under `test.typecheck`. Replace these keys: typecheck → test.typecheck.enabled, typecheckOnly → test.typecheck.only, typecheckTsconfig → test.typecheck.tsconfig",
		);
	});

	it("should accept a typecheck object under test:", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				test: { typecheck: { enabled: true, include: ["**/*.spec-d.ts"], only: false } },
			});
		}).not.toThrow();
	});

	it("should accept ignoreSourceErrors in the typecheck object", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				test: { typecheck: { enabled: true, ignoreSourceErrors: true } },
			});
		}).not.toThrow();
	});

	it("should accept spawnTimeout in the typecheck object", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				test: { typecheck: { enabled: true, spawnTimeout: 5000 } },
			});
		}).not.toThrow();
	});

	it("should reject a non-positive spawnTimeout", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { typecheck: { spawnTimeout: 0 } } })).toThrow(
			/Invalid config/,
		);
	});

	it("should reject unknown keys inside the typecheck object", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { typecheck: { bogus: true } } })).toThrow(
			/Invalid config/,
		);
	});

	it("should accept gameOutput as a string", () => {
		expect.assertions(1);

		expect(() => validateConfig({ gameOutput: "logs.json" })).not.toThrow();
	});

	it("should accept gameOutput as true", () => {
		expect.assertions(1);

		expect(() => validateConfig({ gameOutput: true })).not.toThrow();
	});

	it("should reject gameOutput as false", () => {
		expect.assertions(1);

		expect(() => validateConfig({ gameOutput: false })).toThrow(/Invalid config/);
	});

	it("should accept outputFile as a string", () => {
		expect.assertions(1);

		expect(() => validateConfig({ outputFile: "results.json" })).not.toThrow();
	});

	it("should accept outputFile as true", () => {
		expect.assertions(1);

		expect(() => validateConfig({ outputFile: true })).not.toThrow();
	});

	it("should reject outputFile as false", () => {
		expect.assertions(1);

		expect(() => validateConfig({ outputFile: false })).toThrow(/Invalid config/);
	});

	it("should accept workspace.gameOutput as true", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { gameOutput: true } })).not.toThrow();
	});

	it("should accept workspace.outputFile as true", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { outputFile: true } })).not.toThrow();
	});

	it("should reject workspace.outputFile as a string", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { outputFile: "results.json" } })).toThrow(
			/Invalid config/,
		);
	});

	it("should reject workspace.gameOutput as a string", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { gameOutput: "logs.json" } })).toThrow(
			/Invalid config/,
		);
	});

	it("should reject workspace.gameOutput as false", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { gameOutput: false } })).toThrow(
			/Invalid config/,
		);
	});

	it("should reject unknown keys inside workspace", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { unknown: true } })).toThrow(/Invalid config/);
	});

	it("should accept workspace.root with workspace.packages", () => {
		expect.assertions(1);

		expect(() =>
			validateConfig({ workspace: { packages: ["packages/*"], root: "." } }),
		).not.toThrow();
	});

	it("should reject workspace.packages without workspace.root", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { packages: ["packages/*"] } })).toThrow(
			/workspace\.root.*workspace\.packages.*together/s,
		);
	});

	it("should reject workspace.root without workspace.packages", () => {
		expect.assertions(1);

		expect(() => validateConfig({ workspace: { root: "." } })).toThrow(
			/workspace\.root.*workspace\.packages.*together/s,
		);
	});

	it("should accept workspace.root/packages alongside gameOutput", () => {
		expect.assertions(1);

		expect(() => {
			return validateConfig({
				workspace: { gameOutput: true, packages: ["packages/*"], root: "." },
			});
		}).not.toThrow();
	});

	it("should reject test.slowTestThreshold of 0", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { slowTestThreshold: 0 } })).toThrow(
			/slowTestThreshold/,
		);
	});

	it("should reject negative test.slowTestThreshold", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { slowTestThreshold: -100 } })).toThrow(
			/slowTestThreshold/,
		);
	});

	it("should reject NaN test.slowTestThreshold", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { slowTestThreshold: Number.NaN } })).toThrow(
			/slowTestThreshold/,
		);
	});

	it("should accept positive test.slowTestThreshold", () => {
		expect.assertions(1);

		expect(() => validateConfig({ test: { slowTestThreshold: 500 } })).not.toThrow();
	});
});
