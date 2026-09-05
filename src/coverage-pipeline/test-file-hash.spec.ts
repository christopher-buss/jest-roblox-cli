import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { hashFile } from "../utils/hash.ts";
import { resolveTestFileHash } from "./test-file-hash.ts";

function mapperResolving(diskPath: string | undefined) {
	return { resolveTestFilePath: () => diskPath };
}

describe(resolveTestFileHash, () => {
	it("should hash the resolved test file when it exists on disk", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", "describe('m', () => {})");

		expect(
			resolveTestFileHash(
				mapperResolving("/src/m.spec.ts"),
				"ReplicatedStorage/m.spec",
				fileSystem,
			),
		).toBe(hashFile("/src/m.spec.ts", fileSystem));
	});

	it("should return undefined when the resolved file is absent", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveTestFileHash(
				mapperResolving("/src/missing.spec.ts"),
				"ReplicatedStorage/missing.spec",
				fileSystem,
			),
		).toBeUndefined();
	});

	it("should return undefined when the path cannot be resolved", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveTestFileHash(mapperResolving(undefined), "ReplicatedStorage/x.spec", fileSystem),
		).toBeUndefined();
	});

	it("should return undefined when there is no source mapper", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveTestFileHash(undefined, "ReplicatedStorage/x.spec", fileSystem),
		).toBeUndefined();
	});
});
