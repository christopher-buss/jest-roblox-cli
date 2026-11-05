import { describe, expect, it } from "vitest";

import {
	GLOBAL_TEST_KEYS,
	PROJECT_TEST_KEYS,
	ROOT_CLI_KEYS,
	ROOT_CLI_KEYS_LIST,
	SHARED_TEST_KEYS,
} from "./config-keys.ts";

describe("rOOT_CLI_KEYS", () => {
	it("should contain backend", () => {
		expect.assertions(1);

		expect(ROOT_CLI_KEYS.has("backend")).toBeTrue();
	});

	it("should contain exactly the CLI/runner key list", () => {
		expect.assertions(1);

		expect([...ROOT_CLI_KEYS].sort()).toStrictEqual(ROOT_CLI_KEYS_LIST.toSorted());
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

	it("should contain projectTimeout", () => {
		expect.assertions(1);

		expect(SHARED_TEST_KEYS.has("projectTimeout")).toBeTrue();
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
