import { fromPartial } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { nodeFileSystem } from "../utils/file-system.ts";
import { ensurePackageDirectories } from "./ensure-paths.ts";
import type { PackageDescriptor } from "./preflight.ts";

type LoadRojoProject = (typeof import("@isentinel/rojo-utils"))["loadRojoProject"];

const loadRojoProject = vi.hoisted(() => vi.fn<LoadRojoProject>());

vi.mock(import("@isentinel/rojo-utils"), async (importOriginal) => {
	return { ...(await importOriginal()), loadRojoProject };
});

function createTemporaryProject(): { projectPath: string; temporaryRoot: string } {
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-cli-"));
	onTestFinished(() => {
		fs.rmSync(temporaryRoot, { force: true, recursive: true });
	});

	const projectPath = path.join(temporaryRoot, "default.project.json");
	fs.writeFileSync(projectPath, "{}");
	return { projectPath, temporaryRoot };
}

describe(ensurePackageDirectories, () => {
	it("should create only directory-shaped Rojo paths recursively", () => {
		expect.assertions(2);

		const { projectPath, temporaryRoot } = createTemporaryProject();
		loadRojoProject.mockReturnValue(
			fromPartial({
				name: "fixture",
				tree: {
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
		);

		ensurePackageDirectories([
			fromPartial<PackageDescriptor>({ rojoProjectPath: projectPath }),
		]);

		expect(loadRojoProject).toHaveBeenCalledExactlyOnceWith(projectPath, nodeFileSystem);
		expect({
			file: fs.existsSync(path.join(temporaryRoot, "src/file.luau")),
			metadata: fs.existsSync(path.join(temporaryRoot, "src/meta.json")),
			nested: fs.statSync(path.join(temporaryRoot, "src/nested")).isDirectory(),
			plain: fs.statSync(path.join(temporaryRoot, "src/plain")).isDirectory(),
			withExtension: fs.statSync(path.join(temporaryRoot, "src/with.ext")).isDirectory(),
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

		const { projectPath, temporaryRoot } = createTemporaryProject();
		loadRojoProject.mockImplementation(() => {
			throw new Error("invalid project");
		});

		expect(() => {
			ensurePackageDirectories([
				fromPartial<PackageDescriptor>({
					rojoProjectPath: path.join(temporaryRoot, "missing.json"),
				}),
				fromPartial<PackageDescriptor>({ rojoProjectPath: projectPath }),
			]);
		}).not.toThrow();
		expect(loadRojoProject).toHaveBeenCalledExactlyOnceWith(projectPath, nodeFileSystem);
	});
});
