import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { parseVersionedManifest } from "./manifest-parse.ts";

const schema = type({ name: "string", version: "number" });

function parseContents(contents?: string) {
	const { fileSystem, volume } = createMemoryFileSystem();
	if (contents !== undefined) {
		volume.mkdirSync("/m", { recursive: true });
		volume.writeFileSync("/m/manifest.json", contents);
	}

	return parseVersionedManifest({
		expectedVersion: 2,
		filePath: "/m/manifest.json",
		fileSystem,
		schema,
	});
}

describe(parseVersionedManifest, () => {
	it("should report a missing file", () => {
		expect.assertions(1);

		expect(parseContents()).toStrictEqual({ kind: "missing" });
	});

	it("should rethrow an IO error other than a missing file", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync("/m/manifest.json", { recursive: true });

		expect(() => {
			return parseVersionedManifest({
				expectedVersion: 2,
				filePath: "/m/manifest.json",
				fileSystem,
				schema,
			});
		}).toThrow("EISDIR");
	});

	it("should report malformed JSON", () => {
		expect.assertions(1);

		expect(parseContents("not json")).toStrictEqual({ kind: "malformed-json" });
	});

	it.for(["[]", "null", "3"])("should reject the non-object %s", (contents) => {
		expect.assertions(1);

		expect(parseContents(contents)).toStrictEqual({
			kind: "invalid",
			summary: "manifest must be a JSON object",
		});
	});

	it("should report a version mismatch before validating the schema", () => {
		expect.assertions(1);

		expect(parseContents(JSON.stringify({ version: 1 }))).toStrictEqual({
			actual: 1,
			expected: 2,
			kind: "version-mismatch",
		});
	});

	it("should report a schema failure with its summary", () => {
		expect.assertions(1);

		expect(parseContents(JSON.stringify({ version: 2 }))).toStrictEqual({
			kind: "invalid",
			summary: expect.stringContaining("name"),
		});
	});

	it("should return the validated manifest", () => {
		expect.assertions(1);

		expect(parseContents(JSON.stringify({ name: "a", version: 2 }))).toStrictEqual({
			kind: "ok",
			manifest: { name: "a", version: 2 },
		});
	});
});
