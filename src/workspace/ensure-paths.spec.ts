import { fromPartial } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { ensurePackageDirectories } from "./ensure-paths.ts";
import type { PackageDescriptor } from "./preflight.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/packages/foo");
const PROJECT_PATH = path.join(PACKAGE_DIRECTORY, "test.project.json");

function packagePath(relativePath: string): string {
	return path.join(PACKAGE_DIRECTORY, relativePath);
}

describe(ensurePackageDirectories, () => {
	it("should create only directory-shaped Rojo paths recursively", () => {
		expect.assertions(4);

		const { fileSystem, volume } = createMemoryFileSystem({
			[packagePath("src/existing/marker.txt")]: "",
			[PROJECT_PATH]: JSON.stringify({
				name: "fixture",
				tree: {
					$className: "DataModel",
					Existing: { $path: "src/existing" },
					FolderByChild: {
						$path: "src/with.ext",
						Child: { $className: "Folder" },
					},
					MetadataOnly: { $path: "src/meta.json", $properties: {} },
					Nested: { Child: { $path: "src/nested" } },
					Nested$: { Child: { $path: "src/ends-with-dollar" } },
					PlainDirectory: { $path: "src/plain" },
					SourceFile: { $path: "src/file.luau" },
				},
			}),
		});
		const mkdirSync = vi.spyOn(fileSystem, "mkdirSync");
		const readFileSync = vi.spyOn(fileSystem, "readFileSync");
		const missingProject = packagePath("missing.project.json");

		ensurePackageDirectories(
			[
				fromPartial<PackageDescriptor>({ rojoProjectPath: PROJECT_PATH }),
				fromPartial<PackageDescriptor>({ rojoProjectPath: missingProject }),
			],
			fileSystem,
		);

		expect({
			endsWithDollar: volume.statSync(packagePath("src/ends-with-dollar")).isDirectory(),
			file: volume.existsSync(packagePath("src/file.luau")),
			metadata: volume.existsSync(packagePath("src/meta.json")),
			modelClassPath: volume.existsSync(packagePath("DataModel")),
			nested: volume.statSync(packagePath("src/nested")).isDirectory(),
			plain: volume.statSync(packagePath("src/plain")).isDirectory(),
			withExtension: volume.statSync(packagePath("src/with.ext")).isDirectory(),
		}).toStrictEqual({
			endsWithDollar: true,
			file: false,
			metadata: false,
			modelClassPath: false,
			nested: true,
			plain: true,
			withExtension: true,
		});
		expect(mkdirSync).toHaveBeenCalledWith(normalizeWindowsPath(packagePath("src/plain")), {
			recursive: true,
		});
		expect(mkdirSync).not.toHaveBeenCalledWith(
			normalizeWindowsPath(packagePath("src/existing")),
			expect.anything(),
		);
		expect(readFileSync.mock.calls.map(([file]) => file)).not.toContain(missingProject);
	});

	it("should ignore missing and malformed projects", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const temporaryRoot = path.resolve("fixture");
		const projectPath = path.join(temporaryRoot, "default.project.json");
		fileSystem.mkdirSync(temporaryRoot, { recursive: true });
		fileSystem.writeFileSync(projectPath, "{}");

		expect(() => {
			ensurePackageDirectories(
				[
					fromPartial<PackageDescriptor>({
						rojoProjectPath: path.join(temporaryRoot, "missing.json"),
					}),
					fromPartial<PackageDescriptor>({ rojoProjectPath: projectPath }),
				],
				fileSystem,
			);
		}).not.toThrow();
		expect(fileSystem.readdirSync(temporaryRoot)).toStrictEqual(["default.project.json"]);
	});
});
