import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { validatePackages } from "./preflight.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");

function projectJson(json: object): string {
	return String(JSON.stringify(json));
}

describe(validatePackages, () => {
	it("should return no errors when all files and $path targets resolve", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
			[path.join(FOO_DIR, "src/init.luau")]: "return {}",
			[path.join(FOO_DIR, "test.project.json")]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "src" },
				},
			}),
		});

		const errors = validatePackages([
			{
				name: "@halcyon/foo",
				packageDirectory: FOO_DIR,
				rojoProjectPath: path.join(FOO_DIR, "test.project.json"),
			},
		]);

		expect(errors).toStrictEqual([]);
	});

	it("should report when rojoProject file is missing", () => {
		expect.assertions(3);

		vol.reset();

		vol.fromJSON({ [path.join(FOO_DIR, "jest.config.ts")]: "export default {}" });

		const errors = validatePackages([
			{
				name: "@halcyon/foo",
				packageDirectory: FOO_DIR,
				rojoProjectPath: path.join(FOO_DIR, "test.project.json"),
			},
		]);

		expect(errors).toHaveLength(1);
		expect(errors[0]?.package).toBe("@halcyon/foo");
		expect(errors[0]?.reason ?? "").toMatch(/rojoProject not found/);
	});

	it("should report when rojoProject fails to parse", () => {
		expect.assertions(3);

		vol.reset();

		vol.fromJSON({
			[path.join(FOO_DIR, "test.project.json")]: "not json {{",
		});

		const errors = validatePackages([
			{
				name: "@halcyon/foo",
				packageDirectory: FOO_DIR,
				rojoProjectPath: path.join(FOO_DIR, "test.project.json"),
			},
		]);

		expect(errors).toHaveLength(1);
		expect(errors[0]?.package).toBe("@halcyon/foo");
		expect(errors[0]?.reason ?? "").toMatch(/failed to parse rojoProject/);
	});

	it("should report each missing $path target", () => {
		expect.assertions(1);

		vol.reset();

		vol.fromJSON({
			[path.join(FOO_DIR, "src/init.luau")]: "",
			[path.join(FOO_DIR, "test.project.json")]: projectJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "src" },
					ServerScriptService: { $path: "server" },
				},
			}),
		});

		const errors = validatePackages([
			{
				name: "@halcyon/foo",
				packageDirectory: FOO_DIR,
				rojoProjectPath: path.join(FOO_DIR, "test.project.json"),
			},
		]);

		expect(errors).toStrictEqual([
			{ package: "@halcyon/foo", reason: "$path target not found: server" },
		]);
	});

	it("should validate multiple packages and aggregate errors", () => {
		expect.assertions(1);

		vol.reset();

		const barDirectory = path.join(ROOT, "packages/bar");
		vol.fromJSON({
			[path.join(barDirectory, "test.project.json")]: projectJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "missing" },
				},
			}),
			[path.join(FOO_DIR, "test.project.json")]: projectJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});

		const errors = validatePackages([
			{
				name: "@halcyon/foo",
				packageDirectory: FOO_DIR,
				rojoProjectPath: path.join(FOO_DIR, "test.project.json"),
			},
			{
				name: "@halcyon/bar",
				packageDirectory: barDirectory,
				rojoProjectPath: path.join(barDirectory, "test.project.json"),
			},
		]);

		expect(errors).toStrictEqual([
			{ package: "@halcyon/bar", reason: "$path target not found: missing" },
		]);
	});
});
