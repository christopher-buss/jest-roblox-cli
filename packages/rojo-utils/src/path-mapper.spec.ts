import { describe, expect, it } from "vitest";

import { mapFsPathToDataModel, mapFsRootToDataModel } from "./path-mapper.ts";
import type { RojoTreeNode } from "./types.ts";

const simpleRojoTree: RojoTreeNode = {
	$className: "DataModel",
	ReplicatedStorage: {
		client: { $path: "out/client" },
	},
	ServerScriptService: {
		server: { $path: "out/server" },
	},
};

describe(mapFsRootToDataModel, () => {
	it("should map outDir to DataModel path via Rojo tree", () => {
		expect.assertions(1);

		expect(mapFsRootToDataModel("out/client", simpleRojoTree)).toBe("ReplicatedStorage/client");
	});

	it("should map server outDir to DataModel path", () => {
		expect.assertions(1);

		expect(mapFsRootToDataModel("out/server", simpleRojoTree)).toBe(
			"ServerScriptService/server",
		);
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

		expect(mapFsRootToDataModel("out/shared/lib", nestedTree)).toBe(
			"ReplicatedStorage/shared/lib",
		);
	});

	it("should handle path nested under a $path entry", () => {
		expect.assertions(1);

		expect(mapFsRootToDataModel("out/client/ui", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/ui",
		);
	});

	it("should throw when no mapping found", () => {
		expect.assertions(1);

		expect(() => mapFsRootToDataModel("out/unknown", simpleRojoTree)).toThrow(
			/No Rojo tree mapping found for path: out\/unknown\n\nAvailable \$path entries: out\/client, out\/server/,
		);
	});

	it("should omit available paths line when tree has no $path entries", () => {
		expect.assertions(1);

		const emptyTree: RojoTreeNode = { $className: "DataModel" };

		expect(() => mapFsRootToDataModel("out/foo", emptyTree)).toThrow(
			"No Rojo tree mapping found for path: out/foo",
		);
	});

	it("should strip trailing slash before lookup", () => {
		expect.assertions(1);

		expect(mapFsRootToDataModel("out/client/", simpleRojoTree)).toBe(
			"ReplicatedStorage/client",
		);
	});

	it("should look up source path directly for pure Luau", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: { $path: "shared" },
			},
		};

		expect(mapFsRootToDataModel("shared", tree)).toBe("ReplicatedStorage/shared");
	});
});

describe(mapFsPathToDataModel, () => {
	it("should map a .luau file path to DataModel path", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out/client/Button.luau", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/Button",
		);
	});

	it("should map a .lua file path to DataModel path", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out/client/Button.lua", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/Button",
		);
	});

	it("should handle init.luau by mapping to parent", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out/client/Button/init.luau", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/Button",
		);
	});

	it("should handle init.lua by mapping to parent", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out/client/Button/init.lua", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/Button",
		);
	});

	it("should normalize backslashes", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out\\client\\Button.luau", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/Button",
		);
	});

	it("should return undefined when no mapping found", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("unknown/file.luau", simpleRojoTree)).toBeUndefined();
	});

	it("should handle paths without Luau extension", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out/client/Button", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/Button",
		);
	});

	it("should handle deeply nested paths", () => {
		expect.assertions(1);

		expect(mapFsPathToDataModel("out/client/components/ui/Button.luau", simpleRojoTree)).toBe(
			"ReplicatedStorage/client/components/ui/Button",
		);
	});
});
