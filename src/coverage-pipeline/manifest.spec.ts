import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { CoverageManifest, ReadManifestResult } from "./manifest.ts";
import { MANIFEST_VERSION, readManifest, writeManifest } from "./manifest.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

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

function expectInvalid(result: ReadManifestResult): { summary: string } {
	if (result.kind !== "invalid") {
		throw new Error(`expected invalid, got ${result.kind}`);
	}

	return { summary: result.summary };
}

function expectVersionMismatch(result: ReadManifestResult): {
	actual: unknown;
	expected: number;
} {
	if (result.kind !== "version-mismatch") {
		throw new Error(`expected version-mismatch, got ${result.kind}`);
	}

	return { actual: result.actual, expected: result.expected };
}

describe(writeManifest, () => {
	it("should round-trip through readManifest", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const manifest = exampleManifest();
		writeManifest("/coverage/manifest.json", manifest);

		expect(expectOk(readManifest("/coverage/manifest.json"))).toStrictEqual(manifest);
	});

	it("should round-trip per-test attribution records", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

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
		writeManifest("/coverage/manifest.json", manifest);

		expect(expectOk(readManifest("/coverage/manifest.json"))).toStrictEqual(manifest);
	});

	it("should create parent directories before writing", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		writeManifest("/nested/dir/coverage/manifest.json", exampleManifest());

		expect(vol.existsSync("/nested/dir/coverage/manifest.json")).toBeTrue();
	});
});

describe(readManifest, () => {
	it("should return missing when file does not exist", () => {
		expect.assertions(1);

		const result = readManifest("/nonexistent/manifest.json");

		expect(result.kind).toBe("missing");
	});

	it("should return malformed-json when file contains invalid JSON", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", "{ not json");

		const result = readManifest("/coverage/manifest.json");

		expect(result.kind).toBe("malformed-json");
	});

	it("should return invalid when JSON root is not an object", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(["not", "an", "object"]));

		expect(expectInvalid(readManifest("/coverage/manifest.json")).summary).toContain("object");
	});

	it("should return invalid when JSON is the literal null", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", "null");

		const result = readManifest("/coverage/manifest.json");

		expect(result.kind).toBe("invalid");
	});

	it("should return version-mismatch when version is a different number", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const otherVersion = MANIFEST_VERSION + 1;
		const manifest = { ...exampleManifest(), version: otherVersion };
		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		const mismatch = expectVersionMismatch(readManifest("/coverage/manifest.json"));

		expect(mismatch.expected).toBe(MANIFEST_VERSION);
		expect(mismatch.actual).toBe(otherVersion);
	});

	it("should reject caches written by the pre-rojo-rewriter-collapse layout (version 1)", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const manifest = { ...exampleManifest(), version: 1 };
		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		expect(readManifest("/coverage/manifest.json").kind).toBe("version-mismatch");
	});

	it("should reject v2 caches (pre-buildId) as version-mismatch", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const manifest = { ...exampleManifest(), version: 2 };
		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(manifest));

		expect(readManifest("/coverage/manifest.json").kind).toBe("version-mismatch");
	});

	it("should return invalid when buildId is absent", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const { buildId, ...withoutBuildId } = exampleManifest();
		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(withoutBuildId));

		expect(readManifest("/coverage/manifest.json").kind).toBe("invalid");
	});

	it("should return invalid (not version-mismatch) when version field is absent", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify({ generatedAt: "x" }));

		const result = readManifest("/coverage/manifest.json");

		expect(result.kind).toBe("invalid");
	});

	it("should return invalid when version field is a non-numeric value", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify({ version: "not-a-number" }));

		const result = readManifest("/coverage/manifest.json");

		expect(result.kind).toBe("invalid");
	});

	it("should return invalid when coveringTestIds is not an array of test ids", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

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
		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(malformed));

		expect(readManifest("/coverage/manifest.json").kind).toBe("invalid");
	});

	it("should return invalid when a test record is missing its source hash", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const malformed = {
			...exampleManifest(),
			tests: [
				{ testCaseId: "math > adds", testFilePath: "out/math.spec.luau", testId: "t1" },
			],
		};
		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/manifest.json", JSON.stringify(malformed));

		expect(readManifest("/coverage/manifest.json").kind).toBe("invalid");
	});

	it("should return invalid when version matches but body fails schema", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync(
			"/coverage/manifest.json",
			JSON.stringify({ generatedAt: 123, version: MANIFEST_VERSION }),
		);

		expect(expectInvalid(readManifest("/coverage/manifest.json")).summary).not.toHaveLength(0);
	});

	it("should propagate non-ENOENT IO errors rather than misreport as malformed-json", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// Reading a directory triggers EISDIR — a non-ENOENT IO error that
		// must not be folded into the malformed-json case (which would
		// mislead callers into thinking the file is corrupt).
		vol.mkdirSync("/coverage/manifest.json", { recursive: true });

		expect(() => readManifest("/coverage/manifest.json")).toThrow(/EISDIR|illegal/i);
	});
});
