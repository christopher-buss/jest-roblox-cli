import { describe, expect, it } from "vitest";

import { createSnapshotPathResolver } from "./path-resolver.ts";

describe(createSnapshotPathResolver, () => {
	it("should resolve virtual path to filesystem path", () => {
		expect.assertions(1);

		const resolver = createSnapshotPathResolver({
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "out/shared",
					},
				},
			},
		});

		expect(
			resolver.resolve("ReplicatedStorage/components/__snapshots__/Button.spec.snap.luau")
				?.filePath,
		).toBe("out/shared/components/__snapshots__/Button.spec.snap.luau");
	});

	it("should replace outDir with rootDir for TypeScript projects", () => {
		expect.assertions(1);

		const resolver = createSnapshotPathResolver({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "out/shared",
					},
				},
			},
		});

		expect(
			resolver.resolve("ReplicatedStorage/components/__snapshots__/Button.spec.snap.luau")
				?.filePath,
		).toBe("src/shared/components/__snapshots__/Button.spec.snap.luau");
	});

	it("should match longest prefix when multiple mappings exist", () => {
		expect.assertions(2);

		const resolver = createSnapshotPathResolver({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "out/shared",
						client: {
							$path: "out/client",
						},
					},
				},
			},
		});

		expect(
			resolver.resolve("ReplicatedStorage/client/__snapshots__/Foo.spec.snap.luau")?.filePath,
		).toBe("src/client/__snapshots__/Foo.spec.snap.luau");

		expect(
			resolver.resolve("ReplicatedStorage/other/__snapshots__/Bar.spec.snap.luau")?.filePath,
		).toBe("src/shared/other/__snapshots__/Bar.spec.snap.luau");
	});

	it("should not replace outDir when it appears as substring in basePath", () => {
		expect.assertions(1);

		const resolver = createSnapshotPathResolver({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						// "output" contains "out" but is a different directory
						$path: "output/client",
					},
				},
			},
		});

		// cspell:ignore srcput
		// Without boundary guard, replace("out","src") would corrupt to
		// "srcput/client/..."
		expect(
			resolver.resolve("ReplicatedStorage/lib/__snapshots__/foo.spec.snap.luau")?.filePath,
		).toBe("output/client/lib/__snapshots__/foo.spec.snap.luau");
	});

	it("should not match prefix that is substring of path segment", () => {
		expect.assertions(1);

		const resolver = createSnapshotPathResolver({
			rojoProject: {
				name: "test",
				tree: {
					Rep: {
						$path: "out/rep",
					},
				},
			},
		});

		// "Rep" is a string prefix of "ReplicatedStorage" but not a segment match
		expect(
			resolver.resolve("ReplicatedStorage/lib/__snapshots__/foo.spec.snap.luau"),
		).toBeUndefined();
	});

	it("should return undefined for unknown path", () => {
		expect.assertions(1);

		const resolver = createSnapshotPathResolver({
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "out/shared",
					},
				},
			},
		});

		expect(resolver.resolve("Workspace/unknown/snap.luau")).toBeUndefined();
	});

	it("should return matched mapping for TypeScript paths", () => {
		expect.assertions(1);

		const mapping = { outDir: "out", rootDir: "src" };
		const resolver = createSnapshotPathResolver({
			mappings: [mapping],
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "out/shared",
					},
				},
			},
		});

		expect(
			resolver.resolve("ReplicatedStorage/components/__snapshots__/Button.spec.snap.luau")
				?.mapping,
		).toStrictEqual(mapping);
	});

	it("should return no mapping when basePath matches no outDir", () => {
		expect.assertions(1);

		const resolver = createSnapshotPathResolver({
			mappings: [{ outDir: "out", rootDir: "src" }],
			rojoProject: {
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "other/shared",
					},
				},
			},
		});

		expect(resolver.resolve("ReplicatedStorage/foo/snap.luau")?.mapping).toBeUndefined();
	});
});
