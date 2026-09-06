import { fromPartial } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { ensurePackageDirectories } from "./ensure-paths.ts";
import type { PackageDescriptor } from "./preflight.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/packages/foo");
const PROJECT_PATH = path.join(PACKAGE_DIRECTORY, "test.project.json");

function packagePath(relativePath: string): string {
	return path.join(PACKAGE_DIRECTORY, relativePath);
}

describe(ensurePackageDirectories, () => {
	it("should create only directory-shaped Rojo paths recursively", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({
			[PROJECT_PATH]: JSON.stringify({
				name: "fixture",
				tree: {
					$className: "DataModel",
					FolderByChild: {
						$path: "src/with.ext",
						Child: { $className: "Folder" },
					},
					MetadataOnly: { $path: "src/meta.json", $properties: {} },
					Nested: { Child: { $path: "src/nested" } },
					PlainDirectory: { $path: "src/plain" },
					SourceFile: { $path: "src/file.luau" },
				},
			}),
		});

		ensurePackageDirectories(
			[fromPartial<PackageDescriptor>({ rojoProjectPath: PROJECT_PATH })],
			fileSystem,
		);

		expect({
			file: volume.existsSync(packagePath("src/file.luau")),
			metadata: volume.existsSync(packagePath("src/meta.json")),
			nested: volume.statSync(packagePath("src/nested")).isDirectory(),
			plain: volume.statSync(packagePath("src/plain")).isDirectory(),
			withExtension: volume.statSync(packagePath("src/with.ext")).isDirectory(),
		}).toStrictEqual({
			file: false,
			metadata: false,
			nested: true,
			plain: true,
			withExtension: true,
		});
	});

	it("should ignore missing and malformed projects", () => {
		expect.assertions(2);

		const temporaryRoot = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-cli-")),
		);
		onTestFinished(() => {
			fs.rmSync(temporaryRoot, { force: true, recursive: true });
		});

		const projectPath = path.join(temporaryRoot, "default.project.json");
		fs.writeFileSync(projectPath, "{}");

		expect(() => {
			ensurePackageDirectories([
				fromPartial<PackageDescriptor>({
					rojoProjectPath: path.join(temporaryRoot, "missing.json"),
				}),
				fromPartial<PackageDescriptor>({ rojoProjectPath: projectPath }),
			]);
		}).not.toThrow();
		expect(fs.readdirSync(temporaryRoot)).toStrictEqual(["default.project.json"]);
	});
});
