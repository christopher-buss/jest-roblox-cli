import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { configErrorLike } from "#test/mocks/run-config-error.ts";
import { injectStubMounts } from "./stub-injection.ts";

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const STUB_PATH = path.join(ROOT, ".cache/foo/jest.config.luau");

function fooPath(relative: string): string {
	return posixPath(path.join(FOO_DIR, relative));
}

function child(node: RojoTreeNode | undefined, ...keys: Array<string>): RojoTreeNode | undefined {
	return keys.reduce<RojoTreeNode | undefined>((current, key) => {
		const value = current?.[key];
		return isRojoTreeNode(value) ? value : undefined;
	}, node);
}

function storage(node: RojoTreeNode): RojoTreeNode {
	return { ReplicatedStorage: { $className: "ReplicatedStorage", ...node } };
}

describe(injectStubMounts, () => {
	it("should inject jest.config child at dataModelPath leaf", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});
		const root = storage({ Common: { $path: fooPath("src") } });

		injectStubMounts({
			fileSystem,
			root,
			stubMounts: [{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/Common" }],
		});

		expect(child(root, "ReplicatedStorage", "Common", "jest.config")!.$path).toBe(
			posixPath(STUB_PATH),
		);
	});

	it("should leave the tree alone without stubMounts", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const root = storage({ Common: { $path: fooPath("src") } });

		expect(injectStubMounts({ fileSystem, root, stubMounts: undefined })).toStrictEqual([]);
		expect(root).toStrictEqual(storage({ Common: { $path: fooPath("src") } }));
	});

	it("should inject multiple stubMounts", () => {
		expect.assertions(2);

		const stubA = path.join(ROOT, ".cache/foo/a/jest.config.luau");
		const stubB = path.join(ROOT, ".cache/foo/b/jest.config.luau");
		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "src/a/init.luau")]: "",
			[path.join(FOO_DIR, "src/b/init.luau")]: "",
		});
		const root = storage({ A: { $path: fooPath("src/a") }, B: { $path: fooPath("src/b") } });

		injectStubMounts({
			fileSystem,
			root,
			stubMounts: [
				{ absStubPath: stubA, dataModelPath: "ReplicatedStorage/A" },
				{ absStubPath: stubB, dataModelPath: "ReplicatedStorage/B" },
			],
		});

		expect(child(root, "ReplicatedStorage", "A", "jest.config")!.$path).toBe(posixPath(stubA));
		expect(child(root, "ReplicatedStorage", "B", "jest.config")!.$path).toBe(posixPath(stubB));
	});

	it.for(["jest.config.lua", "jest.config.luau"])(
		"should report a %s in the leaf source dir as replaced",
		(userConfig) => {
			expect.assertions(2);

			const sourceDirectory = path.join(FOO_DIR, "src");
			const { fileSystem } = createMemoryFileSystem({
				[path.join(sourceDirectory, "init.luau")]: "",
				[path.join(sourceDirectory, userConfig)]: "return {}",
			});
			const root = storage({ Common: { $path: fooPath("src") } });

			const replaced = injectStubMounts({
				fileSystem,
				root,
				stubMounts: [{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/Common" }],
			});

			expect(replaced).toStrictEqual([posixPath(path.join(sourceDirectory, userConfig))]);
			expect(child(root, "ReplicatedStorage", "Common", "jest.config")!.$path).toBe(
				posixPath(STUB_PATH),
			);
		},
	);

	it("should report nothing replaced when the leaf source dir holds only unrelated files", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "src/config.lua")]: "",
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		expect(
			injectStubMounts({
				fileSystem,
				root: storage({ Common: { $path: fooPath("src") } }),
				stubMounts: [{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/Common" }],
			}),
		).toStrictEqual([]);
	});

	it("should throw ConfigError when dataModelPath does not resolve in the tree", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		expect(() => {
			injectStubMounts({
				fileSystem,
				root: {
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: fooPath("src") },
				},
				stubMounts: [
					{ absStubPath: "/cache/stub.lua", dataModelPath: "ReplicatedStorage/Missing" },
				],
			});
		}).toThrow(
			configErrorLike(
				'stubMount dataModelPath "ReplicatedStorage/Missing" does not resolve in synthesized tree (missing segment "Missing")',
			),
		);
	});

	it("should report nothing replaced when the leaf has no $path", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const root = storage({ Branch: { $className: "Folder", Leaf: { $path: fooPath("src") } } });

		const replaced = injectStubMounts({
			fileSystem,
			root,
			stubMounts: [
				{ absStubPath: "/cache/stub.lua", dataModelPath: "ReplicatedStorage/Branch" },
			],
		});

		expect(replaced).toStrictEqual([]);
		expect(child(root, "ReplicatedStorage", "Branch", "jest.config")).toBeDefined();
	});

	it("should demote a $path-mounted parent to reach a stubMount child on disk", () => {
		expect.assertions(5);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/test/init.luau")]: "",
		});
		const root = storage({ "foo:tests": { $path: fooPath("out-test") } });

		injectStubMounts({
			fileSystem,
			root,
			stubMounts: [
				{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/foo:tests/src" },
			],
		});

		const fooTests = child(root, "ReplicatedStorage", "foo:tests");

		expect(fooTests!.$path).toBeUndefined();
		expect(fooTests!.$className).toBe("Folder");
		expect(child(fooTests, "src")!.$path).toBe(fooPath("out-test/src"));
		expect(child(fooTests, "test")!.$path).toBe(fooPath("out-test/test"));
		expect(child(fooTests, "src", "jest.config")!.$path).toBe(posixPath(STUB_PATH));
	});

	it("should promote only directories without a $ prefix during demotion", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "out-test/$weird/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/loose.luau")]: "return {}",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
		});
		const root = storage({ Tests: { $path: fooPath("out-test") } });

		injectStubMounts({
			fileSystem,
			root,
			stubMounts: [{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/Tests/src" }],
		});

		const tests = child(root, "ReplicatedStorage", "Tests");

		expect(tests!["loose.luau"]).toBeUndefined();
		expect(tests!["$weird"]).toBeUndefined();
		expect(tests!["src"]).toBeDefined();
	});

	it("should preserve existing explicit children during demotion", () => {
		expect.assertions(1);

		const extra = posixPath(path.join(ROOT, "packages/other/extra"));
		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "out-test/keep/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
		});
		const root = storage({ Tests: { $path: fooPath("out-test"), keep: { $path: extra } } });

		injectStubMounts({
			fileSystem,
			root,
			stubMounts: [{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/Tests/src" }],
		});

		expect(child(root, "ReplicatedStorage", "Tests", "keep")!.$path).toBe(extra);
	});

	it("should demote multiple consecutive $path-mounted segments", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "out-test/src/foo/init.luau")]: "",
		});
		const root = storage({ Tests: { $path: fooPath("out-test") } });

		injectStubMounts({
			fileSystem,
			root,
			stubMounts: [
				{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage/Tests/src/foo" },
			],
		});

		expect(child(root, "ReplicatedStorage", "Tests", "src", "foo", "jest.config")!.$path).toBe(
			posixPath(STUB_PATH),
		);
	});

	it.for([
		["a $-prefixed segment", { Tests: { $path: fooPath("out-test") } }, "Tests/$weird"],
		["a parent without $path", { Branch: { $className: "Folder" } }, "Branch/Missing"],
		["an optional path value", { Maybe: { optional: "out-test" } }, "Maybe"],
	] as const)("should throw ConfigError on %s", ([, node, leaf]) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "out-test/$weird/init.luau")]: "",
		});

		expect(() => {
			injectStubMounts({
				fileSystem,
				root: storage(structuredClone(node)),
				stubMounts: [
					{ absStubPath: "/cache/stub.lua", dataModelPath: `ReplicatedStorage/${leaf}` },
				],
			});
		}).toThrow(configErrorLike());
	});

	it.for(["leaf.luau", "missing"])(
		"should throw ConfigError without reading the parent when %s is not a directory",
		(segment) => {
			expect.assertions(2);

			const { fileSystem } = createMemoryFileSystem({
				[path.join(FOO_DIR, "out-test/leaf.luau")]: "",
			});
			const readdir = vi.spyOn(fileSystem, "readdirSync");

			expect(() => {
				injectStubMounts({
					fileSystem,
					root: storage({ Tests: { $path: fooPath("out-test") } }),
					stubMounts: [
						{
							absStubPath: "/cache/stub.lua",
							dataModelPath: `ReplicatedStorage/Tests/${segment}`,
						},
					],
				});
			}).toThrow(configErrorLike());
			expect(readdir).not.toHaveBeenCalled();
		},
	);

	it("should error when the tree already declares a jest.config child at the leaf", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		expect(() => {
			injectStubMounts({
				fileSystem,
				root: {
					ReplicatedStorage: {
						"$className": "ReplicatedStorage",
						"$path": fooPath("src"),
						"jest.config": { $path: fooPath("configs/custom-jest.luau") },
					},
				},
				stubMounts: [{ absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage" }],
			});
		}).toThrow(
			configErrorLike(
				'stubMount at "ReplicatedStorage" would overwrite an existing "jest.config" child already declared in the project tree. ' +
					"Remove the explicit declaration from your .project.json.",
			),
		);
	});

	it("should inject once when mounts share one leaf and stub", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const root: RojoTreeNode = {
			ReplicatedStorage: { $className: "ReplicatedStorage", $path: fooPath("out-test") },
		};
		const mount = { absStubPath: STUB_PATH, dataModelPath: "ReplicatedStorage" };

		injectStubMounts({ fileSystem, root, stubMounts: [mount, { ...mount }] });

		expect(child(root, "ReplicatedStorage", "jest.config")!.$path).toBe(posixPath(STUB_PATH));
	});

	it("should error when two mounts share a leaf but point at different stubs", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(() => {
			injectStubMounts({
				fileSystem,
				root: {
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						$path: fooPath("out-test"),
					},
				},
				stubMounts: [
					{
						absStubPath: path.join(FOO_DIR, "a.luau"),
						dataModelPath: "ReplicatedStorage",
					},
					{
						absStubPath: path.join(FOO_DIR, "b.luau"),
						dataModelPath: "ReplicatedStorage",
					},
				],
			});
		}).toThrow(configErrorLike(/would overwrite an existing "jest\.config" child/));
	});
});
