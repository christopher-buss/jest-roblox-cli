import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { copyIgnoreMatcher } from "#test/mocks/coverage-copy-ignore.ts";
import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import type { PackageIgnore, WorkspacePackageDescriptor } from "./workspace-prepare-types.ts";
import { narrowPackageRoots } from "./workspace-roots.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/packages/foo");
const PROJECT_PATH = path.join(PACKAGE_DIRECTORY, "test.project.json");

function noIgnore(): PackageIgnore {
	return {
		copyMatcher: copyIgnoreMatcher([]),
		matcher: () => false,
	};
}

function seedPackage(volume: MemoryVolume, mounts: Array<string>): void {
	volume.fromJSON({
		[PROJECT_PATH]: JSON.stringify({
			name: "foo",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: Object.fromEntries(
					mounts.map((mount) => [mount, { $path: mount }]),
				),
			},
		}),
	});
	for (const mount of mounts) {
		volume.mkdirSync(path.join(PACKAGE_DIRECTORY, mount), { recursive: true });
		volume.writeFileSync(path.join(PACKAGE_DIRECTORY, mount, "init.luau"), "local x = 1");
	}
}

function descriptorFor(luauRoots?: Array<string>): WorkspacePackageDescriptor {
	return {
		name: "@scope/foo",
		luauRoots,
		packageDirectory: PACKAGE_DIRECTORY,
		rojoProjectPath: PROJECT_PATH,
	};
}

describe(narrowPackageRoots, () => {
	it("should answer each mounted root in package-relative terms", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, ["out"]);

		expect(
			narrowPackageRoots({
				descriptor: descriptorFor(),
				fileSystem,
				ignore: noIgnore(),
				universe: undefined,
			}),
		).toStrictEqual([{ luauRoot: posixRoot("out"), roots: [posixRoot("out")], spine: [] }]);
	});

	it("should discover roblox-ts output mounts without explicit roots", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, ["out/shared"]);
		volume.writeFileSync(
			path.join(PACKAGE_DIRECTORY, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { outDir: "out" } }),
		);

		expect(
			narrowPackageRoots({
				descriptor: descriptorFor(),
				fileSystem,
				ignore: noIgnore(),
				universe: undefined,
			}),
		).toStrictEqual([
			{ luauRoot: posixRoot("out/shared"), roots: [posixRoot("out/shared")], spine: [] },
		]);
	});

	it("should fall back to tsconfig output when Rojo has no Luau files", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, []);
		volume.fromJSON({ [path.join(PACKAGE_DIRECTORY, "out/init.luau")]: "return {}" });

		expect(
			narrowPackageRoots({
				descriptor: descriptorFor(),
				fileSystem,
				ignore: noIgnore(),
				tsconfigReader: () => {
					return {
						config: { compilerOptions: { outDir: "out" } },
						path: "tsconfig.json",
					};
				},
				universe: undefined,
			}),
		).toStrictEqual([{ luauRoot: posixRoot("out"), roots: [posixRoot("out")], spine: [] }]);
	});

	it.for([null, { config: {}, path: "tsconfig.json" }])(
		"should fail when tsconfig supplies no output: %j",
		(tsconfig) => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedPackage(volume, []);

			expect(() => {
				return narrowPackageRoots({
					descriptor: descriptorFor(),
					fileSystem,
					ignore: noIgnore(),
					tsconfigReader: () => tsconfig,
					universe: undefined,
				});
			}).toThrow('Could not determine luauRoots for package "@scope/foo"');
		},
	);

	it("should skip an explicit root that escapes the package, with a warning", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, ["out"]);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(() => {
			return narrowPackageRoots({
				descriptor: descriptorFor(["../bar"]),
				fileSystem,
				ignore: noIgnore(),
				universe: undefined,
			});
		}).toThrow('Could not determine luauRoots for package "@scope/foo"');
		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining('luauRoot "../bar" in @scope/foo is not a directory inside'),
		);
	});
});
