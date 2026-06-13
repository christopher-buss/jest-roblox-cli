import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { instrumentRoot } from "../../../src/coverage-pipeline/instrumenter.ts";
import { createRbxtsFixtureSandbox } from "../../e2e/cli/helpers.ts";

const LUAU_FIXTURE_SRC = path.resolve(__dirname, "../../e2e/fixtures/luau-project/src");
const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "jest-roblox-e2e-"));
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

describe("coverage instrumentation", () => {
	describe("luau project", () => {
		it("should instrument luau source files", () => {
			expect.assertions(3);

			const shadowDirectory = createTemporaryDirectory();

			const files = instrumentRoot({
				luauRoot: LUAU_FIXTURE_SRC,
				shadowDir: shadowDirectory,
			});

			const keys = Object.keys(files);

			expect(keys.length).toBeGreaterThan(0);

			// Should have instrumented the example.luau file
			const exampleKey = keys.find((key) => key.includes("example.luau"));

			expect(exampleKey).toBeDefined();

			// Instrumented file should exist in shadow directory
			const record = files[exampleKey!];

			expect(existsSync(record!.instrumentedLuauPath)).toBeTrue();
		});

		it("should generate coverage map files", () => {
			expect.assertions(1);

			const shadowDirectory = createTemporaryDirectory();

			const files = instrumentRoot({
				luauRoot: LUAU_FIXTURE_SRC,
				shadowDir: shadowDirectory,
			});

			const records = Object.values(files);
			const allHaveCoverageMaps = records.every((record) =>
				existsSync(record.coverageMapPath),
			);

			expect(allHaveCoverageMaps).toBeTrue();
		});
	});

	describe("roblox-ts project (compiled output)", () => {
		it("should instrument compiled luau files", () => {
			expect.assertions(2);

			const shadowDirectory = createTemporaryDirectory();
			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);

			const files = instrumentRoot({
				luauRoot: path.join(fixtureRoot, "out"),
				shadowDir: shadowDirectory,
			});

			const keys = Object.keys(files);

			expect(keys.length).toBeGreaterThan(0);

			// Should have instrumented .luau files from the compiled output
			const luauFiles = keys.filter((key) => key.endsWith(".luau"));

			expect(luauFiles.length).toBeGreaterThanOrEqual(1);
		});

		it("should reference source map paths for compiled files", () => {
			expect.assertions(1);

			const shadowDirectory = createTemporaryDirectory();
			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);

			const files = instrumentRoot({
				luauRoot: path.join(fixtureRoot, "out"),
				shadowDir: shadowDirectory,
			});

			const records = Object.values(files);
			const allHaveSourceMapPaths = records.every((record) =>
				record.sourceMapPath.endsWith(".map"),
			);

			expect(allHaveSourceMapPaths).toBeTrue();
		});
	});
});
