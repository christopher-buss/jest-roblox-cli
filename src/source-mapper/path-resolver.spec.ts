import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createPathResolver } from "./path-resolver.ts";

vi.mock(import("node:fs"), () => ({ existsSync: vi.fn<typeof existsSync>(() => false) }));

describe(createPathResolver, () => {
	it("should parse simple rojo tree", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject);

		expect(resolver.resolve("ReplicatedStorage.foo")?.filePath).toBe("out/shared/foo.luau");
	});

	it("should parse nested rojo tree", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					client: {
						$path: "out/client",
					},
					server: {
						$path: "out/server",
					},
				},
			},
		};

		const resolver = createPathResolver(rojoProject);

		expect(resolver.resolve("ReplicatedStorage.client.foo")?.filePath).toBe(
			"out/client/foo.luau",
		);
		expect(resolver.resolve("ReplicatedStorage.server.bar")?.filePath).toBe(
			"out/server/bar.luau",
		);
	});

	it("should map outDir to rootDir for TypeScript source", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			mappings: [{ outDir: "out", rootDir: "src" }],
		});

		expect(resolver.resolve("ReplicatedStorage.foo")?.filePath).toBe("src/shared/foo.ts");
	});

	it("should return matched mapping for TypeScript paths", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const mapping = { outDir: "out", rootDir: "src" };
		const resolver = createPathResolver(rojoProject, { mappings: [mapping] });

		expect(resolver.resolve("ReplicatedStorage.foo")?.mapping).toStrictEqual(mapping);
	});

	it("should return undefined mapping for Luau paths", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject);

		expect(resolver.resolve("ReplicatedStorage.foo")?.mapping).toBeUndefined();
	});

	it("should return undefined for unknown path", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject);

		expect(resolver.resolve("ServerStorage.unknown")).toBeUndefined();
	});

	it("should prefer .luau over .lua when both exist", () => {
		expect.assertions(1);

		vi.mocked(existsSync).mockImplementation((path) => path === "out/shared/foo.luau");

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject);

		expect(resolver.resolve("ReplicatedStorage.foo")?.filePath).toBe("out/shared/foo.luau");
	});

	it("should match longest prefix when keys share a common prefix", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					"flux": { $path: "out" },
					"flux:tests": { $path: "out-test" },
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			mappings: [{ outDir: "out-test", rootDir: "src" }],
		});

		expect(resolver.resolve("ReplicatedStorage.flux:tests.actions.define.spec")?.filePath).toBe(
			"src/actions/define.spec.ts",
		);
	});

	it("should fall back to Luau when basePath matches no mapping", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					"flux:tests": { $path: "out-test" },
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			mappings: [{ outDir: "out", rootDir: "src" }],
		});

		const result = resolver.resolve("ReplicatedStorage.flux:tests.src.actions.define.spec");

		expect(result?.filePath).toBe("out-test/src/actions/define.spec.luau");
		expect(result?.mapping).toBeUndefined();
	});

	it("should resolve different mappings for different basePaths", () => {
		expect.assertions(2);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					"flux": { $path: "out" },
					"flux:tests": { $path: "out-test" },
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			mappings: [
				{ outDir: "out", rootDir: "src" },
				{ outDir: "out-test", rootDir: "." },
			],
		});

		expect(resolver.resolve("ReplicatedStorage.flux.actions.define")?.filePath).toBe(
			"src/actions/define.ts",
		);
		expect(
			resolver.resolve("ReplicatedStorage.flux:tests.src.actions.define.spec")?.filePath,
		).toBe("src/actions/define.spec.ts");
	});

	it("should map init back to index for TypeScript paths", () => {
		expect.assertions(1);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			mappings: [{ outDir: "out", rootDir: "src" }],
		});

		expect(resolver.resolve("ReplicatedStorage.init.spec")?.filePath).toBe(
			"src/shared/index.spec.ts",
		);
	});

	it("should fall back to .lua when .luau does not exist", () => {
		expect.assertions(1);

		vi.mocked(existsSync).mockImplementation((path) => path === "out/shared/foo.lua");

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject);

		expect(resolver.resolve("ReplicatedStorage.foo")?.filePath).toBe("out/shared/foo.lua");
	});
});
