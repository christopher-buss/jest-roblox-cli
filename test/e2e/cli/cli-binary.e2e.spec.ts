import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "./helpers.ts";

const LUAU_FIXTURE = path.resolve(__dirname, "../fixtures/luau-project");
const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

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

	// Discovery runs before backend resolution, so reaching "No backend
	// available" is itself the proof that discovery found the spec files — a
	// discovery failure prints "No test files found" and stops earlier.
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

	it("should short-circuit --typecheckOnly --passWithNoTests before backend resolution", () => {
		expect.assertions(3);

		// `--typecheckOnly` is pure-local tsgo: with no Type Tests to run and
		// `--passWithNoTests`, the run exits 0 WITHOUT resolving a backend. The
		// absence of "No backend available" proves the type-only short-circuit
		// fired ahead of any Open Cloud / Studio resolution.
		const result = runCli(["--typecheckOnly", "--passWithNoTests"], RBXTS_FIXTURE);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("No test files found");
		expect(result.stderr).not.toContain("No backend available");
	});

	// Which argv `parseArgs` accepts and rejects is settled in `cli.spec.ts`
	// (`auto`, the equals form, bare, `0`, `-1`, `xyz`) under a 100% branch
	// threshold. One case survives here, for the only thing a subprocess adds:
	// a parse throw reaching the exit code and stderr rather than a stack trace.
	it("should reject --parallel 0 with a clear error", () => {
		expect.assertions(2);

		const result = runCli(
			["--parallel", "0", "--typecheckOnly", "--passWithNoTests"],
			RBXTS_FIXTURE,
		);

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.stderr).toContain("Invalid --parallel value");
	});
});
