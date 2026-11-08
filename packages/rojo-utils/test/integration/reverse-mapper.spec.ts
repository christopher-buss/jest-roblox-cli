import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import type { ReverseMapper } from "#src/index.ts";
import { createReverseMapper, RojoResolver } from "#src/index.ts";

interface Project {
	mapper: ReverseMapper;
	root: string;
}

const FILES = new Map<string, string>([
	[
		"default.project.json",
		JSON.stringify({
			name: "Game",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: { Nested: { $path: "nested" }, Shared: { $path: "src/shared" } },
				ServerScriptService: { $path: "src/server" },
			},
		}),
	],
	["nested/default.project.json", JSON.stringify({ name: "Nested", tree: { $path: "source" } })],
	["nested/source/module.luau", "return {}\n"],
	["src/server/main.server.luau", "print('main')\n"],
	["src/shared/folder/child.luau", "return {}\n"],
	["src/shared/folder/init.luau", "return {}\n"],
]);

function makeProject(): Project {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rojo-reverse-")));
	onTestFinished(() => {
		fs.rmSync(root, { force: true, recursive: true });
	});
	const files: Array<string> = [];
	for (const [relativePath, contents] of FILES) {
		const filePath = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, contents);
		files.push(filePath);
	}

	const resolver = RojoResolver.fromPath(path.join(root, "default.project.json"));
	const mapper = createReverseMapper(files, (filePath) => {
		return resolver.getRbxPathFromFilePath(filePath);
	});
	return { mapper, root };
}

describe("reverse mapping through a disk-backed Rojo project", () => {
	it("should resolve a script to its source file", () => {
		expect.assertions(1);

		const { mapper, root } = makeProject();

		expect(mapper.resolve(["ServerScriptService", "main"])).toBe(
			path.join(root, "src/server/main.server.luau"),
		);
	});

	it("should resolve a folder to its init module", () => {
		expect.assertions(2);

		const { mapper, root } = makeProject();

		expect(mapper.resolve(["ReplicatedStorage", "Shared", "folder"])).toBe(
			path.join(root, "src/shared/folder/init.luau"),
		);
		expect(mapper.resolve(["ReplicatedStorage", "Shared", "folder", "child"])).toBe(
			path.join(root, "src/shared/folder/child.luau"),
		);
	});

	it("should resolve a module inside a nested project mount", () => {
		expect.assertions(1);

		const { mapper, root } = makeProject();

		expect(mapper.resolve(["ReplicatedStorage", "Nested", "module"])).toBe(
			path.join(root, "nested/source/module.luau"),
		);
	});

	it("should report a DataModel path with no file as unresolved", () => {
		expect.assertions(2);

		const { mapper } = makeProject();

		expect(mapper.resolve(["ReplicatedStorage", "Shared", "missing"])).toBeUndefined();
		expect(mapper.resolve(["ReplicatedStorage", "Shared"])).toBeUndefined();
	});
});
