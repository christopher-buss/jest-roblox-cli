import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "./helpers.ts";

const LUAU_FIXTURE = path.resolve(__dirname, "fixtures/luau-project");
const RBXTS_FIXTURE = path.resolve(__dirname, "fixtures/rbxts-project");

describe("cli binary", () => {
	it("should print help and exit 0", () => {
		expect.assertions(2);

		const result = runCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: jest-roblox");
	});

	it("should print version and exit 0", () => {
		expect.assertions(2);

		const result = runCli(["--version"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("should load luau config and find test files", () => {
		expect.assertions(3);

		const result = runCli([], LUAU_FIXTURE);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).not.toContain("No test files found");
		expect(result.stderr).toContain("No backend available");
	});

	it("should load rbxts config and find test files", () => {
		expect.assertions(3);

		const result = runCli([], RBXTS_FIXTURE);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).not.toContain("No test files found");
		expect(result.stderr).toContain("No backend available");
	});

	it("should still parse --typecheckOnly --passWithNoTests before backend resolution", () => {
		expect.assertions(3);

		const result = runCli(["--typecheckOnly", "--passWithNoTests"], RBXTS_FIXTURE);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).not.toContain("No test files found");
		expect(result.stderr).toContain("No backend available");
	});

	describe("--parallel", () => {
		it("should reject --parallel 0 with a clear error", () => {
			expect.assertions(2);

			const result = runCli(
				["--parallel", "0", "--typecheckOnly", "--passWithNoTests"],
				RBXTS_FIXTURE,
			);

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("Invalid --parallel value");
		});

		it("should reject --parallel=xyz with a clear error", () => {
			expect.assertions(2);

			const result = runCli(
				["--parallel=xyz", "--typecheckOnly", "--passWithNoTests"],
				RBXTS_FIXTURE,
			);

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("Invalid --parallel value");
		});

		it("should accept --parallel auto", () => {
			expect.assertions(2);

			const result = runCli(
				["--parallel", "auto", "--typecheckOnly", "--passWithNoTests"],
				RBXTS_FIXTURE,
			);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).not.toContain("Invalid --parallel");
		});

		it("should accept --parallel=4 equals form", () => {
			expect.assertions(2);

			const result = runCli(
				["--parallel=4", "--typecheckOnly", "--passWithNoTests"],
				RBXTS_FIXTURE,
			);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).not.toContain("Invalid --parallel");
		});
	});
});
