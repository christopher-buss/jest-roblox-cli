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

// Test seam: the synthesized result is JSON we wrote in the test fixture
// above, so the caller asserts the deterministic shape via `as`. Returning
// `unknown` rather than a generic moves the `JSONValue`-sourced cast into
// one place — the rule only flags casts whose source is `JSONValue`, so
// `unknown as ShapeT` at the call sites is rule-clean.
function parseFixture(json: string): unknown {
	return JSON.parse(json);
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

		const parsed = JSON.parse(result);

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
		const { tree } = parseFixture(result) as {
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

		const parsed = JSON.parse(result);

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

		const parsed = parseFixture(result) as {
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

	it("should drop TestService-only $properties when rewriting to Folder", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					TestService: {
						$className: "TestService",
						$properties: { AutoRuns: false, ExecuteWithStudioRun: false },
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

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { TestService: { $properties?: unknown } }>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.TestService.$properties,
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

		const parsed = parseFixture(result) as {
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
		"TestService",
		"Lighting",
		"SoundService",
		"StarterPlayer",
		"StarterPlayerScripts",
		"Workspace",
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

		const parsed = parseFixture(result) as {
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

	it("should add $className Folder to an implicit service node (no $className) when nested", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			// Rojo infers a service from the node name at the DataModel root, so
			// ServerScriptService carries no $className here (Nevermore layout).
			// Once relocated under __pkg_stage it needs an explicit one.
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: {
						Pkg: { $path: "src" },
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
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, Record<string, { $className: string }>>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.["ServerScriptService"]
				?.$className,
		).toBe("Folder");
	});

	it("should not add $className to an implicit service node that already carries a $path", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			// A bare service node with $path and no $className: Rojo mounts the
			// path, so the synthesizer must not override it with a Folder class.
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: { $path: "src" },
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

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, Record<string, { $className?: string }>>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.["ServerScriptService"]
				?.$className,
		).toBeUndefined();
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

		const parsed = parseFixture(result) as {
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

		const parsed = parseFixture(result) as {
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

		const parsed = parseFixture(result) as {
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

		const parsed = parseFixture(result) as {
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

	it("should virtualize a $path-mounted parent to reach a stubMount child on disk", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						"$className": "ReplicatedStorage",
						"foo:tests": { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubPath,
							dataModelPath: "ReplicatedStorage/foo:tests/src",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								"foo:tests": {
									$path: string;
									src: { "$path": string; "jest.config": { $path: string } };
								};
							};
						}
					>;
				};
			};
		};

		const fooTests =
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage["foo:tests"];

		expect(fooTests?.src.$path).toBe(normalizeWindowsPath(path.join(FOO_DIR, "out-test/src")));
		expect(fooTests?.src["jest.config"].$path).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should demote $path-mounted parent so rojo does not auto-mount duplicate siblings", () => {
		expect.assertions(4);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						"$className": "ReplicatedStorage",
						"foo:tests": { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/test/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/foo:tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								"foo:tests": {
									$className?: string;
									$path?: string;
									src: { "$path"?: string; "jest.config"?: { $path: string } };
									test: { $path?: string };
								};
							};
						}
					>;
				};
			};
		};

		const fooTests =
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage["foo:tests"];

		// Parent must not retain `$path` — rojo would auto-mount a duplicate
		// `src`/`test` sibling alongside the explicit overlay.
		expect(fooTests?.$path).toBeUndefined();
		expect(fooTests?.$className).toBe("Folder");
		// Every on-disk sibling at the parent's $path becomes an explicit child
		// so rojo's auto-mount behaviour is preserved despite the $path
		// removal.
		expect(fooTests?.test.$path).toBe(
			normalizeWindowsPath(path.join(FOO_DIR, "out-test/test")),
		);
		expect(fooTests?.src["jest.config"]?.$path).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should skip non-directory siblings during demotion", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/loose.luau")]: "return {}",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								Tests: Record<string, unknown>;
							};
						}
					>;
				};
			};
		};

		const tests =
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Tests;

		// Loose file siblings (which rojo cannot $path-mount as Instances of
		// arbitrary class) are not promoted to explicit children during
		// demotion.
		expect(tests?.["loose.luau"]).toBeUndefined();
		expect(tests?.["src"]).toBeDefined();
	});

	it("should preserve existing explicit children during demotion", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: {
							$path: "out-test",
							keep: { $path: "../other/extra" },
						},
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/keep/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(ROOT, "packages/other/extra/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								Tests: { keep: { $path: string } };
							};
						}
					>;
				};
			};
		};

		const tests =
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Tests;

		// Explicit `keep` already pointed at `../other/extra` — demotion must
		// not overwrite it with the same-named on-disk `out-test/keep`
		// directory.
		expect(tests?.keep.$path).toBe(
			normalizeWindowsPath(path.join(ROOT, "packages/other/extra")),
		);
		expect(tests?.keep.$path).not.toContain("out-test/keep");
	});

	it("should throw ConfigError when virtualization target segment starts with $", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/$weird/init.luau")]: "",
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
								dataModelPath: "ReplicatedStorage/Tests/$weird",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should skip dollar-prefixed disk siblings during demotion", () => {
		expect.assertions(2);

		vol.reset();

		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/$weird/init.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{ absStubPath: stubPath, dataModelPath: "ReplicatedStorage/Tests/src" },
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								Tests: Record<string, unknown>;
							};
						}
					>;
				};
			};
		};

		const tests =
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Tests;

		// `$`-prefixed names collide with rojo's reserved project.json keys
		// (`$path`, `$className`, …) so they must not be added as explicit
		// children even when present on disk.
		expect(tests?.["$weird"]).toBeUndefined();
		expect(tests?.["src"]).toBeDefined();
	});

	it("should virtualize multiple consecutive $path-mounted segments", () => {
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
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/foo/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubPath,
							dataModelPath: "ReplicatedStorage/Tests/src/foo",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								Tests: {
									src: {
										foo: { "$path": string; "jest.config": { $path: string } };
									};
								};
							};
						}
					>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Tests.src.foo[
				"jest.config"
			].$path,
		).toBe(stubPath.replaceAll("\\", "/"));
	});

	it("should throw ConfigError when virtualization parent has no $path", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Branch: { $className: "Folder" },
					},
				},
			}),
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
								dataModelPath: "ReplicatedStorage/Branch/Missing",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should throw ConfigError when virtualization target segment resolves to a file", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/leaf.luau")]: "",
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
								dataModelPath: "ReplicatedStorage/Tests/leaf.luau",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should throw ConfigError when virtualization target segment is missing on disk", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/init.luau")]: "",
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
								dataModelPath: "ReplicatedStorage/Tests/missing",
							},
						],
					},
				],
			});
		}).toThrow(ConfigError);
	});

	it("should propagate coverage shadow dir through a virtualized $path child", () => {
		expect.assertions(2);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out-test"),
		);
		const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Tests: { $path: "out-test" },
					},
				},
			}),
			[path.join(FOO_DIR, "out-test/src/init.luau")]: "",
			[path.join(shadowOut, "src/init.luau")]: "",
			[stubPath]: "return {}",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out-test", shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
					stubMounts: [
						{
							absStubPath: stubPath,
							dataModelPath: "ReplicatedStorage/Tests/src",
						},
					],
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{
							ReplicatedStorage: {
								Tests: {
									$className?: string;
									$path?: string;
									src: { "$path": string; "jest.config": { $path: string } };
								};
							};
						}
					>;
				};
			};
		};

		const tests =
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Tests;

		// Parent demoted (no $path) so rojo doesn't auto-mount a duplicate `src`
		// alongside the explicit overlay; the shadowed prefix is carried on the
		// explicit child instead.
		expect(tests?.$path).toBeUndefined();
		expect(tests?.src.$path).toBe(`${shadowOut}/src`);
	});

	it.for(["jest.config.lua", "jest.config.luau"])(
		"should throw ConfigError when virtualized leaf source dir contains %s",
		(collidingFile) => {
			expect.assertions(2);

			vol.reset();

			const stubPath = path.join(ROOT, ".cache/foo/jest.config.luau");
			const sourceDirectory = path.join(FOO_DIR, "out-test/src");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Tests: { $path: "out-test" },
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
									dataModelPath: "ReplicatedStorage/Tests/src",
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

	it("should produce identical output to a stubMounts-less descriptor when stubMounts is an empty array", () => {
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
					stubMounts: [],
				},
			],
		});

		expect(withEmpty).toBe(baseline);
	});

	it("should swap $path to the per-package coverage shadow dir when coverageRoots is set", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { ReplicatedStorage: { Pkg: { $path: string } } }>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Pkg.$path,
		).toBe(shadowOut);
	});

	it("should leave $path untouched for packages that opt out of coverageRoots", () => {
		expect.assertions(2);

		vol.reset();

		const barProject = path.join(ROOT, "packages/bar/test.project.json");
		const fooShadow = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[barProject]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
			[path.join(ROOT, "packages/bar/out/init.luau")]: "",
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
					coverageRoots: [{ luauRoot: "out", shadowDir: fooShadow }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { ReplicatedStorage: { Pkg: { $path: string } } }>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/bar"]?.ReplicatedStorage.Pkg.$path,
		).toBe(normalizeWindowsPath(path.join(ROOT, "packages/bar/out")));
		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Pkg.$path,
		).toBe(fooShadow);
	});

	it("should pass nested $path entries through the coverage shadow dir prefix", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/client" } },
				},
			}),
			[path.join(FOO_DIR, "out/client/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{ ReplicatedStorage: { Client: { $path: string } } }
					>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Client.$path,
		).toBe(`${shadowOut}/client`);
	});

	it("should normalize trailing slashes on $path before matching coverageRoots", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out/" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<string, { ReplicatedStorage: { Pkg: { $path: string } } }>;
				};
			};
		};

		// Must NOT have a trailing slash → not "<shadowOut>/".
		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Pkg.$path,
		).toBe(shadowOut);
	});

	it("should leave $path entries that don't match any coverageRoot using package-relative resolution", () => {
		expect.assertions(1);

		vol.reset();

		const shadowOut = normalizeWindowsPath(
			path.join(ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out"),
		);
		vol.fromJSON({
			[FOO_PROJECT]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Other: { $path: "vendor" } },
				},
			}),
			[path.join(FOO_DIR, "vendor/init.luau")]: "",
		});

		const result = synthesize({
			packages: [
				{
					name: "@halcyon/foo",
					coverageRoots: [{ luauRoot: "out", shadowDir: shadowOut }],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
		});

		const parsed = parseFixture(result) as {
			tree: {
				ServerStorage: {
					__pkg_stage: Record<
						string,
						{ ReplicatedStorage: { Other: { $path: string } } }
					>;
				};
			};
		};

		expect(
			parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.Other.$path,
		).toBe(normalizeWindowsPath(path.join(FOO_DIR, "vendor")));
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

	describe("no-wrap mode (single-package coverage)", () => {
		it("should return the package's project tree without ServerStorage.__pkg_stage wrap", () => {
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
				wrap: false,
			});

			const parsed = parseFixture(result) as {
				tree: {
					$className: string;
					ReplicatedStorage: { $className: string };
					ServerStorage?: { __pkg_stage?: unknown };
				};
			};

			expect(parsed.tree.ReplicatedStorage.$className).toBe("ReplicatedStorage");
			expect(parsed.tree.ServerStorage?.__pkg_stage).toBeUndefined();
		});

		it("should preserve all top-level project fields (gameId, placeId, globIgnorePaths, servePort, name)", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					gameId: 99,
					globIgnorePaths: ["**/foo.txt"],
					placeId: 100,
					servePort: 12345,
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
				wrap: false,
			});

			expect(JSON.parse(result)).toMatchObject({
				name: "foo-test",
				gameId: 99,
				globIgnorePaths: ["**/foo.txt"],
				placeId: 100,
				servePort: 12345,
			});
		});

		it("should absolutize $path entries against path.dirname(rojoProjectPath)", () => {
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

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result) as {
				tree: { ReplicatedStorage: { $path: string } };
			};

			expect(parsed.tree.ReplicatedStorage.$path).toBe(
				normalizeWindowsPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should redirect $path entries under coverageRoots[].luauRoot to the shadow directory", () => {
			expect.assertions(1);

			vol.reset();

			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/src");
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
						coverageRoots: [{ luauRoot: "src", shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result) as {
				tree: { ReplicatedStorage: { $path: string } };
			};

			expect(parsed.tree.ReplicatedStorage.$path).toBe(normalizeWindowsPath(shadowDirectory));
		});

		it("should redirect coverageRoots[].luauRoot resolved against packageDirectory when rojoProject sits in a subdirectory", () => {
			expect.assertions(1);

			vol.reset();

			const subProject = path.join(FOO_DIR, "config/dev.project.json");
			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/out");
			vol.fromJSON({
				[path.join(FOO_DIR, "out/init.luau")]: "",
				[subProject]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "../out" },
					},
				}),
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [{ luauRoot: "out", shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: subProject,
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result) as {
				tree: { ReplicatedStorage: { $path: string } };
			};

			expect(parsed.tree.ReplicatedStorage.$path).toBe(normalizeWindowsPath(shadowDirectory));
		});
	});

	describe("wrap mode (workspace) dual-base resolution", () => {
		it("should redirect coverageRoots[].luauRoot resolved against packageDirectory when rojoProject sits in a subdirectory", () => {
			expect.assertions(1);

			vol.reset();

			const subProject = path.join(FOO_DIR, "config/dev.project.json");
			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/out");
			vol.fromJSON({
				[path.join(FOO_DIR, "out/init.luau")]: "",
				[subProject]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "../out" },
					},
				}),
			});

			const result = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						coverageRoots: [{ luauRoot: "out", shadowDir: shadowDirectory }],
						packageDirectory: FOO_DIR,
						rojoProjectPath: subProject,
					},
				],
			});

			const parsed = parseFixture(result) as {
				tree: {
					ServerStorage: {
						__pkg_stage: Record<string, { ReplicatedStorage: { $path: string } }>;
					};
				};
			};

			expect(
				parsed.tree.ServerStorage.__pkg_stage["@halcyon/foo"]?.ReplicatedStorage.$path,
			).toBe(normalizeWindowsPath(shadowDirectory));
		});
	});

	describe("no-wrap mode validation", () => {
		it("should throw ConfigError when wrap=false with zero packages", () => {
			expect.assertions(1);
			expect(() => synthesize({ packages: [], wrap: false })).toThrow(ConfigError);
		});

		it("should resolve nested .project.json mounts in no-wrap mode", () => {
			expect.assertions(1);

			vol.reset();

			const nestedProject = path.join(FOO_DIR, "nested.project.json");
			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Common: { $path: "nested.project.json" },
						},
					},
				}),
				[nestedProject]: projectJson({
					name: "nested-test",
					tree: {
						$className: "Folder",
						Sub: { $path: "src" },
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
				wrap: false,
			});

			const parsed = parseFixture(result) as {
				tree: { ReplicatedStorage: { Common: { Sub: { $path: string } } } };
			};

			expect(parsed.tree.ReplicatedStorage.Common.Sub.$path).toBe(
				normalizeWindowsPath(path.join(FOO_DIR, "src")),
			);
		});

		it("should throw ConfigError when wrap=false with more than one package", () => {
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

			expect(() => {
				return synthesize({
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
						},
						{
							name: "@halcyon/bar",
							packageDirectory: path.join(ROOT, "packages/bar"),
							rojoProjectPath: barProject,
						},
					],
					wrap: false,
				});
			}).toThrow(ConfigError);
		});

		// Multi-project + open-cloud wire shape: synthesizer must produce a
		// place-buildable project.json from a single user package with
		// multiple project mounts and stubs in the cache.
		it("should produce a place-ready synthesized project for multi-project + open-cloud shape", () => {
			expect.assertions(5);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "user-game",
					gameId: 4242,
					placeId: 9999,
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$className: "ReplicatedStorage",
							Shared: { $path: "out/Shared" },
						},
						ServerStorage: {
							$className: "ServerStorage",
							Server: { $path: "out/Server" },
						},
					},
				}),
				[path.join(FOO_DIR, ".jest-roblox/cache/server/jest.config.luau")]:
					"-- @generated by jest-roblox\nreturn {}",
				[path.join(FOO_DIR, ".jest-roblox/cache/shared/jest.config.luau")]:
					"-- @generated by jest-roblox\nreturn {}",
				[path.join(FOO_DIR, "out/Server/init.luau")]: "",
				[path.join(FOO_DIR, "out/Shared/init.luau")]: "",
			});

			const result = synthesize({
				packages: [
					{
						name: "@user/game",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						stubMounts: [
							{
								absStubPath: path.join(
									FOO_DIR,
									".jest-roblox/cache/shared/jest.config.luau",
								),
								dataModelPath: "ReplicatedStorage/Shared",
							},
							{
								absStubPath: path.join(
									FOO_DIR,
									".jest-roblox/cache/server/jest.config.luau",
								),
								dataModelPath: "ServerStorage/Server",
							},
						],
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result) as Record<string, unknown>;

			// Top-level user fields preserved.
			expect(parsed).toMatchObject({ name: "user-game", gameId: 4242, placeId: 9999 });

			// Both project mounts retained with stubs injected as named children.
			const tree = parsed["tree"] as {
				ReplicatedStorage: {
					Shared: { "$path": string; "jest.config": { $path: string } };
				};
				ServerStorage: {
					Server: { "$path": string; "jest.config": { $path: string } };
				};
			};

			expect(tree.ReplicatedStorage.Shared.$path).toContain("out");
			expect(tree.ReplicatedStorage.Shared["jest.config"].$path).toContain("shared");
			expect(tree.ServerStorage.Server.$path).toContain("out");
			expect(tree.ServerStorage.Server["jest.config"].$path).toContain("server");
		});

		// Structural collision: the synthesizer must refuse to overwrite a
		// `jest.config` named-child already declared in the user's
		// `.project.json` tree (e.g. mounted from elsewhere via `$path`),
		// not just files-on-disk under the leaf's `$path`.
		it("should error when user's project tree already declares a jest.config named child at the leaf", () => {
			expect.assertions(1);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							"$className": "ReplicatedStorage",
							"$path": "src",
							"jest.config": { $path: "configs/custom-jest.luau" },
						},
					},
				}),
				[path.join(FOO_DIR, ".jest-roblox/jest.config.luau")]: "-- stub",
				[path.join(FOO_DIR, "configs/custom-jest.luau")]: "return {}",
				[path.join(FOO_DIR, "src/init.luau")]: "",
			});

			expect(() => {
				return synthesize({
					packages: [
						{
							name: "@halcyon/foo",
							packageDirectory: FOO_DIR,
							rojoProjectPath: FOO_PROJECT,
							stubMounts: [
								{
									absStubPath: path.join(
										FOO_DIR,
										".jest-roblox/jest.config.luau",
									),
									dataModelPath: "ReplicatedStorage",
								},
							],
						},
					],
					wrap: false,
				});
			}).toThrow(/would overwrite an existing/);
		});

		// Preservation contract: arbitrary unknown top-level keys (future
		// Rojo schema additions, user custom fields) must survive
		// `synthesize(wrap: false)` byte-for-byte, including when
		// `injectStubMounts` mutates the tree.
		it("should preserve arbitrary unknown top-level keys and nested unknown fields through stub injection", () => {
			expect.assertions(4);

			vol.reset();

			vol.fromJSON({
				[FOO_PROJECT]: projectJson({
					name: "foo-test",
					myFutureRojoField: { nested: { deeply: ["a", "b"] } },
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							$bonusUnknownKey: "placeholder",
							$className: "ReplicatedStorage",
							$path: "src",
						},
					},
					unknownTopLevelArray: [1, 2, 3],
					unknownTopLevelString: "preserved please",
				}),
				[path.join(FOO_DIR, ".jest-roblox/jest.config.luau")]: "-- stub\nreturn {}",
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
								absStubPath: path.join(FOO_DIR, ".jest-roblox/jest.config.luau"),
								dataModelPath: "ReplicatedStorage",
							},
						],
					},
				],
				wrap: false,
			});

			const parsed = parseFixture(result) as Record<string, unknown>;

			// Unknown top-level fields survive.
			expect(parsed).toMatchObject({
				myFutureRojoField: { nested: { deeply: ["a", "b"] } },
				unknownTopLevelArray: [1, 2, 3],
				unknownTopLevelString: "preserved please",
			});

			// Unknown $-prefixed nested key survives the absolutizePaths walk.
			const tree = parsed["tree"] as {
				ReplicatedStorage: {
					"$bonusUnknownKey"?: string;
					"jest.config"?: { $path: string };
				};
			};

			expect(tree.ReplicatedStorage.$bonusUnknownKey).toBe("placeholder");

			// Stub injection landed at the right leaf as a named child.
			expect(tree.ReplicatedStorage["jest.config"]).toBeDefined();
			expect(tree.ReplicatedStorage["jest.config"]?.$path).toContain("jest.config.luau");
		});
	});
});
