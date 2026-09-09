import process from "node:process";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createPathResolver, luauInitToIndex } from "./path-resolver.ts";

describe(createPathResolver, () => {
	it.for(["lua", "luau"])("should preserve a directly mounted %s file", (extension) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const filePath = `out/suite.spec.${extension}`;
		const resolver = createPathResolver(
			{ name: "test", tree: { Suite: { $path: filePath } } },
			{ fileSystem },
		);

		expect(resolver.resolve("Suite")).toStrictEqual({ filePath });
	});

	it("should map a directly mounted init script back to its TypeScript source", () => {
		expect.assertions(1);

		const mapping = { outDir: "out", rootDir: "src" };
		const resolver = createPathResolver(
			{ name: "test", tree: { Module: { $path: "out/module/init.luau" } } },
			{ mappings: [mapping] },
		);

		expect(resolver.resolve("Module")).toStrictEqual({
			filePath: "src/module/index.ts",
			mapping,
		});
	});

	it("should resolve a mount whose instance name ends with a dollar sign", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const resolver = createPathResolver(
			{ name: "test", tree: { Cash$: { $path: "out/cash" } } },
			{ fileSystem },
		);

		expect(resolver.resolve("Cash$.wallet")).toStrictEqual({
			filePath: "out/cash/wallet.luau",
		});
	});

	it("should resolve through the deepest mount when its parent is also mounted", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const resolver = createPathResolver(
			{
				name: "test",
				tree: {
					ReplicatedStorage: {
						$path: "out/shared",
						Feature: { $path: "out/feature" },
					},
				},
			},
			{ fileSystem },
		);

		expect(resolver.resolve("ReplicatedStorage.Feature.foo")!.filePath).toBe(
			"out/feature/foo.luau",
		);
	});

	it("should preserve the final test suffix in a source filename", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const resolver = createPathResolver(
			{ name: "test", tree: { ReplicatedStorage: { $path: "out/shared" } } },
			{ fileSystem },
		);

		expect(resolver.resolve("ReplicatedStorage.foo.test")!.filePath).toBe(
			"out/shared/foo.test.luau",
		);
	});

	it("should parse simple rojo tree", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, { fileSystem });

		expect(resolver.resolve("ReplicatedStorage.foo")!.filePath).toBe("out/shared/foo.luau");
	});

	it("should reject unrelated and prefix-colliding DataModel paths", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		const resolver = createPathResolver(
			{ name: "test", tree: { ReplicatedStorage: { $path: "out/shared" } } },
			{ fileSystem },
		);

		expect(resolver.resolve("ServerStorage.foo")).toBeUndefined();
		expect(resolver.resolve("ReplicatedStorageExtra.foo")).toBeUndefined();
	});

	it("should only combine a test suffix at the end of an instance path", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const resolver = createPathResolver(
			{ name: "test", tree: { ReplicatedStorage: { $path: "out/shared" } } },
			{ fileSystem },
		);

		expect(resolver.resolve("ReplicatedStorage.foo.spec.helper")!.filePath).toBe(
			"out/shared/foo/spec/helper.luau",
		);
	});

	it("should parse nested rojo tree", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

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

		const resolver = createPathResolver(rojoProject, { fileSystem });

		expect(resolver.resolve("ReplicatedStorage.client.foo")!.filePath).toBe(
			"out/client/foo.luau",
		);
		expect(resolver.resolve("ReplicatedStorage.server.bar")!.filePath).toBe(
			"out/server/bar.luau",
		);
	});

	it("should map outDir to rootDir for TypeScript source", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			fileSystem,
			mappings: [{ outDir: "out", rootDir: "src" }],
		});

		expect(resolver.resolve("ReplicatedStorage.foo")!.filePath).toBe("src/shared/foo.ts");
	});

	it("should return matched mapping for TypeScript paths", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const mapping = { outDir: "out", rootDir: "src" };
		const resolver = createPathResolver(rojoProject, { fileSystem, mappings: [mapping] });

		expect(resolver.resolve("ReplicatedStorage.foo")!.mapping).toStrictEqual(mapping);
	});

	it("should return undefined mapping for Luau paths", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, { fileSystem });

		expect(resolver.resolve("ReplicatedStorage.foo")!.mapping).toBeUndefined();
	});

	it("should return undefined for unknown path", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, { fileSystem });

		expect(resolver.resolve("ServerStorage.unknown")).toBeUndefined();
	});

	it("should prefer .luau over .lua when both exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem(
			{ "out/shared/foo.lua": "", "out/shared/foo.luau": "" },
			process.cwd(),
		);

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, { fileSystem });

		expect(resolver.resolve("ReplicatedStorage.foo")!.filePath).toBe("out/shared/foo.luau");
	});

	it("should match longest prefix when keys share a common prefix", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

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
			fileSystem,
			mappings: [{ outDir: "out-test", rootDir: "src" }],
		});

		expect(resolver.resolve("ReplicatedStorage.flux:tests.actions.define.spec")!.filePath).toBe(
			"src/actions/define.spec.ts",
		);
	});

	it("should fall back to Luau when basePath matches no mapping", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					"flux:tests": { $path: "out-test" },
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			fileSystem,
			mappings: [{ outDir: "out", rootDir: "src" }],
		});

		const result = resolver.resolve("ReplicatedStorage.flux:tests.src.actions.define.spec");

		expect(result!.filePath).toBe("out-test/src/actions/define.spec.luau");
		expect(result!.mapping).toBeUndefined();
	});

	it("should resolve different mappings for different basePaths", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

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
			fileSystem,
			mappings: [
				{ outDir: "out", rootDir: "src" },
				{ outDir: "out-test", rootDir: "." },
			],
		});

		expect(resolver.resolve("ReplicatedStorage.flux.actions.define")!.filePath).toBe(
			"src/actions/define.ts",
		);
		expect(
			resolver.resolve("ReplicatedStorage.flux:tests.src.actions.define.spec")!.filePath,
		).toBe("src/actions/define.spec.ts");
	});

	it("should map init back to index for TypeScript paths", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, {
			fileSystem,
			mappings: [{ outDir: "out", rootDir: "src" }],
		});

		expect(resolver.resolve("ReplicatedStorage.init.spec")!.filePath).toBe(
			"src/shared/index.spec.ts",
		);
	});

	it("should fall back to .lua when .luau does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "out/shared/foo.lua": "" }, process.cwd());

		const rojoProject = {
			name: "test",
			tree: {
				ReplicatedStorage: {
					$path: "out/shared",
				},
			},
		};

		const resolver = createPathResolver(rojoProject, { fileSystem });

		expect(resolver.resolve("ReplicatedStorage.foo")!.filePath).toBe("out/shared/foo.lua");
	});
});

describe(luauInitToIndex, () => {
	it("should rewrite a leading init stem to index", () => {
		expect.assertions(1);

		expect(luauInitToIndex("init.spec")).toBe("index.spec");
	});

	it("should rewrite an init segment that follows a slash", () => {
		expect.assertions(1);

		expect(luauInitToIndex("src/shared/init.spec")).toBe("src/shared/index.spec");
	});

	it("should not rewrite a name that merely starts with init", () => {
		expect.assertions(1);

		expect(luauInitToIndex("initialize.spec")).toBe("initialize.spec");
	});

	it("should not rewrite an init substring embedded in a longer word", () => {
		expect.assertions(1);

		expect(luauInitToIndex("src/shared/definite.spec")).toBe("src/shared/definite.spec");
	});
});
