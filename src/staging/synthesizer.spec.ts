import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/errors.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { synthesize } from "./synthesizer.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");

function projectJson(json: object): string {
	return String(JSON.stringify(json));
}

describe(synthesize, () => {
	it("should nest a single package under ServerStorage.__pkg_stage.<name>", () => {
		expect.assertions(2);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed: unknown = JSON.parse(result);

		expect(parsed).toMatchObject({
			tree: {
				$className: "DataModel",
				ServerStorage: {
					__pkg_stage: {
						"$className": "Folder",
						"@halcyon/foo": {
							$className: "Folder",
						},
					},
				},
			},
		});

		// Service-class node at non-root → Folder.
		const { tree } = parsed as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { ReplicatedStorage: { $className: string } }>;
				};
			};
		};

		expect(tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.$className).toBe(
			"Folder",
		);
	});

	it("should hardcode LoadStringEnabled at synth root", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed: unknown = JSON.parse(result);

		expect(parsed).toMatchObject({
			tree: {
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: true },
				},
			},
		});
	});

	it("should drop $properties entirely when only service-only props remain", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						$className: "ServerScriptService",
						$properties: { LoadStringEnabled: true },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { ServerScriptService: { $properties?: unknown } }>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ServerScriptService.$properties,
		).toBeUndefined();
	});

	it("should drop service-only $properties from inlined trees", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						$className: "ServerScriptService",
						$properties: { LoadStringEnabled: true, OtherProp: "kept" },
					},
				},
			}),
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{ ServerScriptService: { $properties?: Record<string, unknown> } }
					>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ServerScriptService.$properties,
		).toStrictEqual({ OtherProp: "kept" });
	});

	it.for([
		"Players",
		"ReplicatedFirst",
		"Teams",
		"TextChatService",
		"LocalizationService",
		"RunService",
		"CollectionService",
		"TweenService",
		"Chat",
		"HttpService",
		"MarketplaceService",
		"MaterialService",
		"MessagingService",
		"UserInputService",
	])("should rewrite service class %s to Folder when nested", (serviceClass) => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					[serviceClass]: { $className: serviceClass, $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, Record<string, { $className: string }>>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.[serviceClass]?.$className,
		).toBe("Folder");
	});

	it("should isolate per-package service roots even when packages claim the same service", () => {
		expect.assertions(2);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[path.join(ROOT, "packages/bar/src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: path.join(ROOT, "packages/bar"),
					rojoProjectPath: barProject,
				},
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { ReplicatedStorage: { $path: string } }>;
				};
			};
		};

		expect(parsed.tree.ServerStorage.__pkg_stage["@halcyon/bar"]?.ReplicatedStorage.$path).toBe(
			normalizeWindowsPath(path.join(ROOT, "packages/bar/src")),
		);
		expect(parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.$path).toBe(
			normalizeWindowsPath(path.join(FOO_DIR, "src")),
		);
	});

	it("should inject jest.config child at dataModelPath leaf for stubMounts", () => {
		expect.assertions(1);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Common: { $path: "src" },
					},
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Common" },
					],
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								Common: { "$path": string; "jest.config": { $path: string } };
							};
						}
					>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Common[
				"jest.config"
			].$path,
		).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should inject multiple stubMounts on a single package", () => {
		expect.assertions(2);

		vol.reset();

		const stubA = path.join(ROOT, ".cache/foo/a/jest.config.luau");
		const stubB = path.join(ROOT, ".cache/foo/b/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						A: { $path: "src/a" },
						B: { $path: "src/b" },
					},
				},
			}),
			[path.join(FOO_DIR, "src/a/init.luau")]: "",
			[path.join(FOO_DIR, "src/b/init.luau")]: "",
			[stubA]: "return {}",
			[stubB]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubA, dataModelPath: "ReplicatedStorage/A" },
						{ absStubPath: stubB, dataModelPath: "ReplicatedStorage/B" },
					],
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								A: { "jest.config": { $path: string } };
								B: { "jest.config": { $path: string } };
							};
						}
					>;
				};
			};
		};

		const package_ = parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"];

		expect(package_?.ReplicatedStorage.A["jest.config"].$path).toBe(
			stubA.replaceAll("\\", "/"),
		);
		expect(package_?.ReplicatedStorage.B["jest.config"].$path).toBe(
			stubB.replaceAll("\\", "/"),
		);
	});

	it("should keep stubMounts isolated per package", () => {
		expect.assertions(2);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		const barDirectory = path.join(ROOT, "packages/bar");
		const stubFoo = path.join(ROOT, ".cache/foo/jest.config.luau");
		const stubBar = path.join(ROOT, ".cache/bar/jest.config.luau");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						BarMount: { $path: "src" },
					},
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						FooMount: { $path: "src" },
					},
				},
			}),
			[path.join(barDirectory, "src/init.luau")]: "",
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[stubBar]: "return {}",
			[stubFoo]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/bar",
					packageDirectory: barDirectory,
					rojoProjectPath: barProject,
					stubMounts: [
						{ absStubPath: stubBar, dataModelPath: "ReplicatedStorage/BarMount" },
					],
				},
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubFoo, dataModelPath: "ReplicatedStorage/FooMount" },
					],
				},
			],
		});

		const parsed = JSON.parse(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: Record<
								string,
								{ "jest.config"?: { $path: string } }
							>;
						}
					>;
				};
			};
		};

		const stage = parsed.tree.ServerStorage.__pkg_stage;

		expect(stage["@halcyon/bar"]?.ReplicatedStorage["BarMount"]?.["jest.config"]?.$path).toBe(
			stubBar.replaceAll("\\", "/"),
		);
		expect(stage["@halcyon/foo"]?.ReplicatedStorage["FooMount"]?.["jest.config"]?.$path).toBe(
			stubFoo.replaceAll("\\", "/"),
		);
	});

	it.for(["jest.config.lua", "jest.config.luau"])(
		"should throw ConfigError when stubMount leaf source dir contains %s",
		(collidingFile) => {
			expect.assertions(2);

			vol.reset();

			const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
			const sourceDirectory = path.join(FOO_DIR, "src");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Common: { $path: "src" },
						},
					},
				}),
				[path.join(sourceDirectory, "init.luau")]: "",
				[path.join(sourceDirectory, collidingFile)]: "return {}",
				[stubPath]: "return {}",
			});

			function callSynthesize(): string {
				return synthesize({
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [
								{
									absStubPath: stubPath,
									dataModelPath: "ReplicatedStorage/Common",
								},
							],
						},
					],
				});
			}

			expect(callSynthesize).toThrow(ConfigError);
			expect(callSynthesize).toThrow(
				path.join(sourceDirectory, collidingFile).replaceAll("\\", "/"),
			);
		},
	);

	it("should not throw when leaf source dir contains unrelated files", () => {
		expect.assertions(1);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		const sourceDirectory = path.join(FOO_DIR, "src");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Common: { $path: "src" },
					},
				},
			}),
			[path.join(sourceDirectory, "config.lua")]: "",
			[path.join(sourceDirectory, "init.luau")]: "",
			[stubPath]: "return {}",
		});

		expect(() => {
			return synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Common" },
						],
					},
				],
			});
		}).not.toThrow();
	});

	it("should throw ConfigError when stubMount dataModelPath does not resolve in the tree", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		expect(() => {
			synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: "/cache/stub.lua",
								dataModelPath: "ReplicatedStorage/Missing",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should skip collision check when stubMount leaf has no $path", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Branch: { $className: "Folder", Leaf: { $path: "src" } },
					},
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: "/cache/stub.lua",
							dataModelPath: "ReplicatedStorage/Branch",
						},
					],
				},
			],
		});

		expect(result).toContain('"jest.config"');
	});

	it("should produce identical output to a stubMounts-less descriptor when stubMounts is omitted", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "",
		});

		const baseline = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});
		const withEmpty = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		expect(withEmpty).toBe(baseline);
	});

	it("should be byte-stable regardless of input package ordering", () => {
		expect.assertions(1);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: { $className: "DataModel" },
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});

		const ordered = synthesize({
			packages: [
				{ name: "@halcyon/bar", packageDirectory: ROOT, rojoProjectPath: barProject },
				{ name: "@halcyon/foo", packageDirectory: ROOT, rojoProjectPath: FOO_PROJECT },
			],
		});
		const reversed = synthesize({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: ROOT, rojoProjectPath: FOO_PROJECT },
				{ name: "@halcyon/bar", packageDirectory: ROOT, rojoProjectPath: barProject },
			],
		});

		expect(ordered).toBe(reversed);
	});
});
