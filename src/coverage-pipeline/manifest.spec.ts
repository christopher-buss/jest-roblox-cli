import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { CoverageManifest, ReadManifestResult } from "./manifest.ts";
import { MANIFEST_VERSION, readManifest, writeManifest } from "./manifest.ts";

function exampleManifest(overrides: Partial<CoverageManifest> = {}): CoverageManifest {
	return {
		buildId: "11111111-1111-1111-1111-111111111111",
		files: {
			"out/init.luau": {
				key: "out/init.luau",
				coverageMapPath: ".jest-roblox/coverage/out/init.luau.cov-map.json",
				instrumentedLuauPath: ".jest-roblox/coverage/out/init.luau",
				originalLuauPath: "out/init.luau",
				sourceHash: "abc123",
				sourceMapPath: "out/init.luau.map",
				statementCount: 3,
			},
		},
		generatedAt: "2026-05-16T00:00:00.000Z",
		instrumenterVersion: 2,
		luauRoots: ["out"],
		nonInstrumentedFiles: {},
		shadowDir: ".jest-roblox/coverage",
		version: MANIFEST_VERSION,
		...overrides,
	};
}

function expectOk(result: ReadManifestResult): CoverageManifest {
	if (result.kind !== "ok") {
		throw new Error(`expected ok, got ${result.kind}`);
	}

	return result.manifest;
}

function expectInvalid(result: ReadManifestResult) {
	if (result.kind !== "invalid") {
		throw new Error(`expected invalid, got ${result.kind}`);
	}

	return { summary: result.summary };
}

function expectVersionMismatch(result: ReadManifestResult) {
	if (result.kind !== "version-mismatch") {
		throw new Error(`expected version-mismatch, got ${result.kind}`);
	}

	return { actual: result.actual, expected: result.expected };
}

describe(writeManifest, () => {
	it("should round-trip through readManifest", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const manifest = exampleManifest();

		writeManifest("/coverage/manifest.json", manifest, fileSystem);

		expect(expectOk(readManifest("/coverage/manifest.json", fileSystem))).toStrictEqual(
			manifest,
		);
	});

	it("should round-trip per-test attribution records", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const manifest = exampleManifest({
			files: {
				"out/init.luau": {
					key: "out/init.luau",
					coverageMapPath: ".jest-roblox/coverage/out/init.luau.cov-map.json",
					coveringTestIds: { "1": ["t1"], "2": ["t1", "t2"] },
					instrumentedLuauPath: ".jest-roblox/coverage/out/init.luau",
					originalLuauPath: "out/init.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/init.luau.map",
					statementCount: 3,
				},
			},
			tests: [
				{
					testCaseId: "math > adds",
					testFilePath: "out/math.spec.luau",
					testFileSourceHash: "hash-a",
					testId: "t1",
				},
				{
					testCaseId: "math > subtracts",
					testFilePath: "out/math.spec.luau",
					testFileSourceHash: "hash-a",
					testId: "t2",
				},
			],
		});

		writeManifest("/coverage/manifest.json", manifest, fileSystem);

		expect(expectOk(readManifest("/coverage/manifest.json", fileSystem))).toStrictEqual(
			manifest,
		);
	});

	it("should round-trip a per-file static-statement set", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const manifest = exampleManifest({
			files: {
				"out/init.luau": {
					key: "out/init.luau",
					coverageMapPath: ".jest-roblox/coverage/out/init.luau.cov-map.json",
					instrumentedLuauPath: ".jest-roblox/coverage/out/init.luau",
					originalLuauPath: "out/init.luau",
					sourceHash: "abc123",
					sourceMapPath: "out/init.luau.map",
					statementCount: 3,
					staticStatementIds: ["0", "2"],
				},
			},
		});

		writeManifest("/coverage/manifest.json", manifest, fileSystem);

		expect(expectOk(readManifest("/coverage/manifest.json", fileSystem))).toStrictEqual(
			manifest,
		);
	});

	it("should create parent directories before writing", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		writeManifest("/nested/dir/coverage/manifest.json", exampleManifest(), fileSystem);

		expect(volume.existsSync("/nested/dir/coverage/manifest.json")).toBeTrue();
	});
});

describe(readManifest, () => {
	it("should return missing when file does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const result = readManifest("/nonexistent/manifest.json", fileSystem);

		expect(result.kind).toBe("missing");
	});

	it("should return malformed-json when file contains invalid JSON", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", "{ not json");

		const result = readManifest("/coverage/manifest.json", fileSystem);

		expect(result.kind).toBe("malformed-json");
	});

	it("should return invalid when JSON root is not an object", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(["not", "an", "object"]));

		expect(
			expectInvalid(readManifest("/coverage/manifest.json", fileSystem)).summary,
		).toContain("object");
	});

	it("should return invalid when JSON is the literal null", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", "null");

		const result = readManifest("/coverage/manifest.json", fileSystem);

		expect(result.kind).toBe("invalid");
	});

	it("should return version-mismatch when version is a different number", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const otherVersion = MANIFEST_VERSION + 1;
		const manifest = { ...exampleManifest(), version: otherVersion };
		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		const mismatch = expectVersionMismatch(readManifest("/coverage/manifest.json", fileSystem));

		expect(mismatch.expected).toBe(MANIFEST_VERSION);
		expect(mismatch.actual).toBe(otherVersion);
	});

	it("should reject caches written by the pre-rojo-rewriter-collapse layout (version 1)", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const manifest = { ...exampleManifest(), version: 1 };
		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("version-mismatch");
	});

	it("should reject v2 caches (pre-buildId) as version-mismatch", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const manifest = { ...exampleManifest(), version: 2 };
		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("version-mismatch");
	});

	it("should reject v3 caches (pre-static-statement-set) as version-mismatch", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const manifest = { ...exampleManifest(), version: 3 };
		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("version-mismatch");
	});

	it("should reject v4 caches (pre-test-location) as version-mismatch", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const manifest = { ...exampleManifest(), version: 4 };
		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("version-mismatch");
	});

	it("should return invalid when buildId is absent", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const { buildId, ...withoutBuildId } = exampleManifest();

		volume.mkdirSync("/coverage", { recursive: true });
		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(withoutBuildId));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("invalid");
	});

	it("should return invalid (not version-mismatch) when version field is absent", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify({ generatedAt: "x" }));

		const result = readManifest("/coverage/manifest.json", fileSystem);

		expect(result.kind).toBe("invalid");
	});

	it("should return invalid when version field is a non-numeric value", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync(
			"/coverage/manifest.json",
			JSON.stringify({ version: "not-a-number" }),
		);

		const result = readManifest("/coverage/manifest.json", fileSystem);

		expect(result.kind).toBe("invalid");
	});

	it("should return invalid when coveringTestIds is not an array of test ids", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const manifest = exampleManifest();

		const malformed = {
			...manifest,
			files: {
				"out/init.luau": {
					...manifest.files["out/init.luau"],
					coveringTestIds: { "1": "not-an-array" },
				},
			},
		};
		volume.mkdirSync("/coverage", { recursive: true });
		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(malformed));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("invalid");
	});

	it("should return invalid when a static-statement set is not an array of ids", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const manifest = exampleManifest();

		const malformed = {
			...manifest,
			files: {
				"out/init.luau": {
					...manifest.files["out/init.luau"],
					staticStatementIds: { "0": true },
				},
			},
		};
		volume.mkdirSync("/coverage", { recursive: true });
		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(malformed));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("invalid");
	});

	it("should return invalid when a test record is missing its source hash", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const malformed = {
			...exampleManifest(),
			tests: [
				{ testCaseId: "math > adds", testFilePath: "out/math.spec.luau", testId: "t1" },
			],
		};
		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync("/coverage/manifest.json", JSON.stringify(malformed));

		expect(readManifest("/coverage/manifest.json", fileSystem).kind).toBe("invalid");
	});

	it("should return invalid when version matches but body fails schema", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/coverage", { recursive: true });

		volume.writeFileSync(
			"/coverage/manifest.json",
			JSON.stringify({ generatedAt: 123, version: MANIFEST_VERSION }),
		);

		expect(
			expectInvalid(readManifest("/coverage/manifest.json", fileSystem)).summary,
		).not.toHaveLength(0);
	});

	it("should propagate non-ENOENT IO errors rather than misreport as malformed-json", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// Reading a directory triggers EISDIR — a non-ENOENT IO error that
		// must not be folded into the malformed-json case (which would
		// mislead callers into thinking the file is corrupt).
		volume.mkdirSync("/coverage/manifest.json", { recursive: true });

		expect(() => readManifest("/coverage/manifest.json", fileSystem)).toThrow(
			/EISDIR|illegal/i,
		);
	});
});
