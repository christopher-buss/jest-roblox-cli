import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ResolvedConfig } from "./config/schema.ts";
import { DEFAULT_CONFIG } from "./config/schema.ts";
import { buildJestArgv, generateTestScript, type JestArgvInput } from "./test-script.ts";

function createConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function createOptions(overrides?: {
	config?: Partial<ResolvedConfig>;
	testFiles?: Array<string>;
}): JestArgvInput {
	return {
		config: createConfig(overrides?.config),
		testFiles: overrides?.testFiles ?? ["src/test.spec.ts"],
	};
}

describe(buildJestArgv, () => {
	it("should strip .tsx?, .lua, and .luau from testMatch patterns", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({
				config: {
					testMatch: ["**/*.spec.ts", "**/*.test.tsx", "**/*.spec.lua", "**/*.test.luau"],
				},
			}),
		);

		expect(argv.testMatch).toStrictEqual(["**/*.spec", "**/*.test", "**/*.spec", "**/*.test"]);
	});

	it("should pass through bail when set", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { bail: 3 } }));

		expect(argv.bail).toBe(3);
	});

	it("should pass through clearMocks/resetMocks/restoreMocks", () => {
		expect.assertions(3);

		const argv = buildJestArgv(
			createOptions({
				config: {
					clearMocks: true,
					resetMocks: true,
					restoreMocks: true,
				},
			}),
		);

		expect(argv.clearMocks).toBeTrue();
		expect(argv.resetMocks).toBeTrue();
		expect(argv.restoreMocks).toBeTrue();
	});

	it("should pass through testTimeout", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { testTimeout: 5000 } }));

		expect(argv.testTimeout).toBe(5000);
	});

	it("should pass through testNamePattern from config", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { testNamePattern: "my test" } }));

		expect(argv.testNamePattern).toBe("my test");
	});

	it("should pass through testPathPattern from config", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({ config: { testPathPattern: "cleanup-destroyed" } }),
		);

		expect(argv).toHaveProperty("testPathPattern", "cleanup-destroyed");
	});

	it("should default reporters to empty array", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions());

		expect(argv.reporters).toBeEmpty();
	});

	it("should preserve user-supplied reporters", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { reporters: ["custom-reporter"] } }));

		expect(argv.reporters).toStrictEqual(["custom-reporter"]);
	});

	it("should inject _timing when TIMING env var is set", () => {
		expect.assertions(1);

		vi.stubEnv("TIMING", "1");
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		const argv = buildJestArgv(createOptions());

		expect(argv).toHaveProperty("_timing", true);
	});

	it("should not inject _timing when TIMING env var is absent", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions());

		expect(argv).not.toHaveProperty("_timing");
	});

	it("should pass through snapshotFormat", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({
				config: { snapshotFormat: { printBasicPrototype: false } },
			}),
		);

		expect(argv.snapshotFormat).toStrictEqual({ printBasicPrototype: false });
	});

	it("should not pass collectCoverage to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { collectCoverage: true } }));

		expect(argv).not.toHaveProperty("collectCoverage");
	});

	it("should inject _coverage when collectCoverage is true", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { collectCoverage: true } }));

		expect(argv).toHaveProperty("_coverage", true);
	});

	it("should not inject _coverage when collectCoverage is false", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { collectCoverage: false } }));

		expect(argv).not.toHaveProperty("_coverage");
	});

	it("should not pass coverageDirectory to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { coverageDirectory: "my-cov" } }));

		expect(argv).not.toHaveProperty("coverageDirectory");
	});

	it("should not pass coveragePathIgnorePatterns to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({ config: { coveragePathIgnorePatterns: ["**/*.test.luau"] } }),
		);

		expect(argv).not.toHaveProperty("coveragePathIgnorePatterns");
	});

	it("should not pass coverageReporters to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { coverageReporters: ["text"] } }));

		expect(argv).not.toHaveProperty("coverageReporters");
	});

	it("should not pass coverageThreshold to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({ config: { coverageThreshold: { statements: 80 } } }),
		);

		expect(argv).not.toHaveProperty("coverageThreshold");
	});

	it("should not pass collectCoverageFrom to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({ config: { collectCoverageFrom: ["src/**/*.luau"] } }),
		);

		expect(argv).not.toHaveProperty("collectCoverageFrom");
	});

	it("should not pass typecheck to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { typecheck: true } }));

		expect(argv).not.toHaveProperty("typecheck");
	});

	it("should not pass typecheckOnly to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { typecheckOnly: true } }));

		expect(argv).not.toHaveProperty("typecheckOnly");
	});

	it("should not pass typecheckTsconfig to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(
			createOptions({ config: { typecheckTsconfig: "tsconfig.test.json" } }),
		);

		expect(argv).not.toHaveProperty("typecheckTsconfig");
	});

	it("should not pass formatters to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { formatters: ["default"] } }));

		expect(argv).not.toHaveProperty("formatters");
	});

	it("should not pass luauRoots to Jest argv", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { luauRoots: ["out"] } }));

		expect(argv).not.toHaveProperty("luauRoots");
	});

	it("should pass jestPath despite being a root-only key", () => {
		expect.assertions(1);

		const argv = buildJestArgv(createOptions({ config: { jestPath: "custom/jest" } }));

		expect(argv).toHaveProperty("jestPath", "custom/jest");
	});
});

describe(generateTestScript, () => {
	it("should contain Jest.runCLI call", () => {
		expect.assertions(1);

		const script = generateTestScript(createOptions());

		expect(script).toContain("Jest.runCLI");
	});

	it("should embed config as JSON", () => {
		expect.assertions(2);

		const script = generateTestScript(createOptions({ config: { verbose: true } }));

		expect(script).toContain("JSONDecode");
		expect(script).toContain('"verbose":true');
	});
});
