import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import {
	collectPaths,
	loadRojoProject,
	mapFsPathToDataModel,
	RbxPathParent,
	RojoResolver,
} from "../../src/index.ts";

function makeProject(): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rojo-integration-")));
	onTestFinished(() => {
		fs.rmSync(root, { force: true, recursive: true });
	});
	fs.mkdirSync(path.join(root, "nested/source"), { recursive: true });
	fs.writeFileSync(path.join(root, "nested/source/module.luau"), "return {}\n");
	fs.writeFileSync(
		path.join(root, "nested/default.project.json"),
		JSON.stringify({ name: "Nested", tree: { $path: "source" } }),
	);
	fs.writeFileSync(
		path.join(root, "default.project.json"),
		JSON.stringify({
			name: "Game",
			tree: { $className: "DataModel", ReplicatedStorage: { Nested: { $path: "nested" } } },
		}),
	);
	return root;
}

describe("disk-backed project API", () => {
	it("should preserve synthetic resolvers as array callbacks", () => {
		expect.assertions(2);

		const root = makeProject();
		const roots = [path.join(root, "first"), path.join(root, "second")];
		for (const directory of roots) {
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, "module.luau"), "return {}\n");
		}

		const resolvers = roots.map(RojoResolver.synthetic);

		expect(
			resolvers[0]!.getRbxPathFromFilePath(path.join(root, "first/module.luau")),
		).toStrictEqual(["module"]);
		expect(
			resolvers[1]!.getRbxPathFromFilePath(path.join(root, "second/module.luau")),
		).toStrictEqual(["module"]);
	});

	it("should use the exported parent marker for each ascending step", () => {
		expect.assertions(3);

		expect(RojoResolver.relative(["A", "B"], [])).toStrictEqual([RbxPathParent, RbxPathParent]);
		expect(RojoResolver.relative(["A", "B"], ["A", "C"])).toStrictEqual([RbxPathParent, "C"]);
		expect(RojoResolver.relative([], ["A"])).toStrictEqual(["A"]);
	});

	it("should agree on loaded mounts, path mapping and resolver snapshots", () => {
		expect.assertions(4);

		const root = makeProject();
		const projectPath = path.join(root, "default.project.json");
		const loaded = loadRojoProject(projectPath);
		const mounts: Array<string> = [];
		collectPaths(loaded.tree, mounts);
		const resolver = RojoResolver.fromPath(projectPath);

		expect(mounts).toStrictEqual(["nested/source"]);
		expect(mapFsPathToDataModel("nested/source/module.luau", loaded.tree)).toBe(
			"ReplicatedStorage/Nested/module",
		);
		expect(
			resolver.getRbxPathFromFilePath(path.join(root, "nested/source/module.luau")),
		).toStrictEqual(["ReplicatedStorage", "Nested", "module"]);
		expect(RojoResolver.fromState(resolver.getState()).getState()).toStrictEqual(
			resolver.getState(),
		);
	});

	it("should follow a directory link through the native filesystem seam", () => {
		expect.assertions(2);

		const root = makeProject();
		fs.symlinkSync(path.join(root, "nested/source"), path.join(root, "linked"), "junction");
		const resolver = RojoResolver.fromTree({ basePath: root, tree: { $path: "linked" } });

		expect(resolver.walkedDirectories).toContain(path.join(root, "nested/source"));
		expect(
			resolver.getRbxPathFromFilePath(path.join(root, "linked/module.luau")),
		).toStrictEqual(["module"]);
	});
});
