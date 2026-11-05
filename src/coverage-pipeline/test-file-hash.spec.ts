import { describe, expect, it } from "vitest";

import { sha256File } from "#test/mocks/coverage-hash.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
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
			resolveTestFileHash({
				fileSystem,
				sourceMapper: mapperResolving("/src/m.spec.ts"),
				testFilePath: "ReplicatedStorage/m.spec",
			}),
		).toBe(sha256File("/src/m.spec.ts", fileSystem));
	});

	it("should return undefined when the resolved file is absent", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveTestFileHash({
				fileSystem,
				sourceMapper: mapperResolving("/src/missing.spec.ts"),
				testFilePath: "ReplicatedStorage/missing.spec",
			}),
		).toBeUndefined();
	});

	it("should return undefined when the path cannot be resolved", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveTestFileHash({
				fileSystem,
				sourceMapper: mapperResolving(undefined),
				testFilePath: "ReplicatedStorage/x.spec",
			}),
		).toBeUndefined();
	});

	it("should return undefined when there is no source mapper", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveTestFileHash({
				fileSystem,
				sourceMapper: undefined,
				testFilePath: "ReplicatedStorage/x.spec",
			}),
		).toBeUndefined();
	});
});
