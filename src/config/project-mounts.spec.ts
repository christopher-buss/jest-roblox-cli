import type { RojoTreeNode } from "@isentinel/rojo-utils";

import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createFsClassifier, resolveMounts } from "./project-mounts.ts";

const simpleRojoTree: RojoTreeNode = {
	$className: "DataModel",
	ReplicatedStorage: {
		client: { $path: "out/client" },
	},
	ServerScriptService: {
		server: { $path: "out/server" },
	},
};

function mapOutDirectory(outDirectory: string, rojoTree: RojoTreeNode): string {
	const mounts = resolveMounts({
		classify: () => "missing",
		displayName: "project",
		project: { displayName: "project", include: [], outDir: outDirectory },
		rojoTree,
		roots: [],
	});

	return mounts[0]!.dataModelPath;
}

function captureMappingError(outDirectory: string, rojoTree: RojoTreeNode): unknown {
	try {
		mapOutDirectory(outDirectory, rojoTree);
	} catch (err) {
		return err;
	}

	throw new Error("expected a mapping error");
}

describe("outDir mapping", () => {
	it("should pin the project to one mount at the outDir", () => {
		expect.assertions(1);

		const mounts = resolveMounts({
			classify: () => "missing",
			displayName: "project",
			project: { displayName: "project", include: [], outDir: "out/client" },
			rojoTree: simpleRojoTree,
			roots: [{ root: "out/server", testMatch: [] }],
		});

		expect(mounts).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
	});

	it("should map outDir to DataModel path via Rojo tree", () => {
		expect.assertions(1);

		const result = mapOutDirectory("out/client", simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client");
	});

	it("should map server outDir to DataModel path", () => {
		expect.assertions(1);

		const result = mapOutDirectory("out/server", simpleRojoTree);

		expect(result).toBe("ServerScriptService/server");
	});

	it("should handle nested tree structures", () => {
		expect.assertions(1);

		const nestedTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: {
					lib: { $path: "out/shared/lib" },
				},
			},
		};

		const result = mapOutDirectory("out/shared/lib", nestedTree);

		expect(result).toBe("ReplicatedStorage/shared/lib");
	});

	it("should handle path nested under a $path entry", () => {
		expect.assertions(1);

		const result = mapOutDirectory("out/client/ui", simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client/ui");
	});

	it("should throw a config error when no mapping found", () => {
		expect.assertions(2);

		expect(captureMappingError("out/unknown", simpleRojoTree)).toBeInstanceOf(Error);
		expect(captureMappingError("out/unknown", simpleRojoTree)).toMatchObject({
			hint: undefined,
			message:
				"No Rojo tree mapping found for path: out/unknown\n\nAvailable $path entries: out/client, out/server",
		});
	});

	it("should include hint when path starts with src/", () => {
		expect.assertions(1);

		expect(captureMappingError("src/client", simpleRojoTree)).toHaveProperty(
			"hint",
			expect.stringMatching(/set "outDir"/),
		);
	});

	it("should omit hint when path does not start with src/", () => {
		expect.assertions(1);

		expect(captureMappingError("out/unknown", simpleRojoTree)).toHaveProperty(
			"hint",
			undefined,
		);
	});

	it("should omit available paths line when tree has no $path entries", () => {
		expect.assertions(1);

		const emptyTree: RojoTreeNode = { $className: "DataModel" };

		expect(() => {
			mapOutDirectory("out/foo", emptyTree);
		}).toThrowWithMessage(Error, "No Rojo tree mapping found for path: out/foo");
	});

	it("should strip trailing slash before lookup", () => {
		expect.assertions(1);

		const result = mapOutDirectory("out/client/", simpleRojoTree);

		expect(result).toBe("ReplicatedStorage/client");
	});

	it("should look up source path directly for pure Luau", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: { $path: "shared" },
			},
		};

		const result = mapOutDirectory("shared", tree);

		expect(result).toBe("ReplicatedStorage/shared");
	});
});

describe(createFsClassifier, () => {
	it("should return 'directory' for a path holding a directory", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/root/some/directory/child.luau": "" });

		expect(createFsClassifier("/root", fileSystem)("some/directory")).toBe("directory");
	});

	it("should return 'file' for a path holding a file", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/root/some/file.txt": "" });

		expect(createFsClassifier("/root", fileSystem)("some/file.txt")).toBe("file");
	});

	it("should return 'missing' for a path holding nothing", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(createFsClassifier("/root", fileSystem)("missing/path")).toBe("missing");
	});

	it("should resolve relative paths against the given root directory", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/workspace/root/src/Client/init.luau": "",
		});

		expect(createFsClassifier("/workspace/root", fileSystem)("src/Client")).toBe("directory");
	});

	it("should pass absolute paths through without resolution", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/absolute/path/init.luau": "" });

		expect(createFsClassifier("/workspace/root", fileSystem)("/absolute/path")).toBe(
			"directory",
		);
	});
});
