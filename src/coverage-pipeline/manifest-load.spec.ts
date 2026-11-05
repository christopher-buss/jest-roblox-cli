import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { MANIFEST_VERSION } from "#test/mocks/coverage-versions.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { loadCoverageManifest } from "./manifest-load.ts";

function loadRejected(manifestText: string): ReturnType<typeof loadCoverageManifest> {
	const { fileSystem } = createMemoryFileSystem();
	const temporaryDirectory = path.resolve("/tmp/cov-test");
	const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
	fileSystem.mkdirSync(coverageDirectory, { recursive: true });
	fileSystem.writeFileSync(path.join(coverageDirectory, "coverage-manifest.json"), manifestText);
	return loadCoverageManifest(temporaryDirectory, fileSystem);
}

describe(loadCoverageManifest, () => {
	it("should return undefined when manifest file does not exist", () => {
		expect.assertions(1);

		const result = loadCoverageManifest("/nonexistent/dir");

		expect(result).toBeUndefined();
	});

	it("should warn and return undefined for malformed manifest JSON", () => {
		expect.assertions(2);

		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(loadRejected("not json")).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
	});

	it("should warn and return undefined for schema-invalid manifest", () => {
		expect.assertions(2);

		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			loadRejected(JSON.stringify({ version: MANIFEST_VERSION, wrong: "schema" })),
		).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("manifest is invalid"));
	});

	it("should warn and return undefined for version-mismatched manifest", () => {
		expect.assertions(2);

		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(loadRejected(JSON.stringify({ version: 99 }))).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("version 99"));
	});

	it("should load valid manifest", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const temporaryDirectory = path.resolve("/tmp/cov-test");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
		fileSystem.mkdirSync(coverageDirectory, { recursive: true });
		const manifest = {
			buildId: "test-build-id",
			files: {
				"shared/player.luau": {
					key: "shared/player.luau",
					coverageMapPath: "shared/player.cov-map.json",
					instrumentedLuauPath: "shared/player.luau",
					originalLuauPath: "out/shared/player.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/shared/player.luau.map",
					statementCount: 10,
				},
			},
			generatedAt: "2026-01-01T00:00:00Z",
			instrumenterVersion: 1,
			luauRoots: ["out"],
			nonInstrumentedFiles: {},
			shadowDir: ".jest-roblox/coverage/out",
			version: MANIFEST_VERSION,
		};
		fileSystem.writeFileSync(
			path.join(coverageDirectory, "coverage-manifest.json"),
			JSON.stringify(manifest),
		);
		const result = loadCoverageManifest(temporaryDirectory, fileSystem);

		expect(result).toBeDefined();
		expect(result!.files["shared/player.luau"]!.statementCount).toBe(10);
	});

	it("should reject the whole manifest when any file record fails validation", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const temporaryDirectory = path.resolve("/tmp/cov-test");
		const coverageDirectory = path.join(temporaryDirectory, ".jest-roblox/coverage");
		fileSystem.mkdirSync(coverageDirectory, { recursive: true });
		const manifest = {
			buildId: "test-build-id",
			files: {
				"shared/invalid.luau": { bad: "record" },
				"shared/valid.luau": {
					key: "shared/valid.luau",
					coverageMapPath: "shared/valid.cov-map.json",
					instrumentedLuauPath: "shared/valid.luau",
					originalLuauPath: "out/shared/valid.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/shared/valid.luau.map",
					statementCount: 5,
				},
			},
			generatedAt: "2026-01-01T00:00:00Z",
			instrumenterVersion: 1,
			luauRoots: ["out"],
			nonInstrumentedFiles: {},
			shadowDir: ".jest-roblox/coverage/out",
			version: MANIFEST_VERSION,
		};
		fileSystem.writeFileSync(
			path.join(coverageDirectory, "coverage-manifest.json"),
			JSON.stringify(manifest),
		);
		const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(loadCoverageManifest(temporaryDirectory, fileSystem)).toBeUndefined();
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("manifest is invalid"));
	});
});
