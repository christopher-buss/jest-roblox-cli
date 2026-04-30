import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
