import { describe, expect, it } from "vitest";

import * as rojo from "./index.ts";

describe("package interface", () => {
	it("should expose the maintained resolver and mapping API", () => {
		expect.assertions(1);

		expect(Object.keys(rojo).sort()).toStrictEqual(
			[
				"CLIENT_SUB_EXTENSION",
				"FileRelation",
				"INIT_NAME",
				"JSON_EXT",
				"NetworkType",
				"ROJO_SCRIPT_EXTS",
				"RbxPathParent",
				"RbxType",
				"RojoResolver",
				"SERVER_SUB_EXTENSION",
				"collectMounts",
				"collectPaths",
				"collectRequiredPaths",
				"convertToLuau",
				"findInTree",
				"isOptionalPath",
				"isRojoTreeNode",
				"loadRojoProject",
				"mapFsPathToDataModel",
				"mapFsRootToDataModel",
				"matchNodePath",
				"pruneAncestors",
				"rebaseTreePaths",
				"resolveMountPath",
				"resolveNestedProjectSources",
				"resolveNestedProjects",
				"stripRojoExtensions",
				"unwrapPath",
			].sort(),
		);
	});
});
