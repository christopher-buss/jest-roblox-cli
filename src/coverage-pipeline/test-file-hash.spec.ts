import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { hashFile } from "../utils/hash.ts";
import { resolveTestFileHash } from "./test-file-hash.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

function mapperResolving(diskPath: string | undefined): {
	resolveTestFilePath: () => string | undefined;
} {
	return { resolveTestFilePath: () => diskPath };
}

describe(resolveTestFileHash, () => {
	it("should hash the resolved test file when it exists on disk", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/src", { recursive: true });
		vol.writeFileSync("/src/m.spec.ts", "describe('m', () => {})");

		expect(
			resolveTestFileHash(mapperResolving("/src/m.spec.ts"), "ReplicatedStorage/m.spec"),
		).toBe(hashFile("/src/m.spec.ts"));
	});

	it("should return undefined when the resolved file is absent", () => {
		expect.assertions(1);

		expect(
			resolveTestFileHash(
				mapperResolving("/src/missing.spec.ts"),
				"ReplicatedStorage/missing.spec",
			),
		).toBeUndefined();
	});

	it("should return undefined when the path cannot be resolved", () => {
		expect.assertions(1);

		expect(
			resolveTestFileHash(mapperResolving(undefined), "ReplicatedStorage/x.spec"),
		).toBeUndefined();
	});

	it("should return undefined when there is no source mapper", () => {
		expect.assertions(1);

		expect(resolveTestFileHash(undefined, "ReplicatedStorage/x.spec")).toBeUndefined();
	});
});
