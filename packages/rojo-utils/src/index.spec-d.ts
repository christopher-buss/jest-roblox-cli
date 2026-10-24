import { describe, expectTypeOf, it } from "vitest";

import type {
	FileSystem,
	LoadedRojoProject,
	RbxPath,
	RojoResolverState,
	RojoTreeNode,
} from "./index.ts";
import { isRojoTreeNode, loadRojoProject, mapFsPathToDataModel, RojoResolver } from "./index.ts";

describe("package types", () => {
	it("should preserve project, mapping and resolver contracts", () => {
		expectTypeOf(loadRojoProject).parameter(0).toEqualTypeOf<string>();
		expectTypeOf(loadRojoProject).parameter(1).toExtend<FileSystem | undefined>();
		expectTypeOf(loadRojoProject).returns.toEqualTypeOf<LoadedRojoProject>();
		expectTypeOf(mapFsPathToDataModel).parameters.toEqualTypeOf<[string, RojoTreeNode]>();
		expectTypeOf(RojoResolver.fromState).parameters.toEqualTypeOf<[RojoResolverState]>();
		expectTypeOf(isRojoTreeNode).parameter(0).toEqualTypeOf<unknown>();
		expectTypeOf(RojoResolver.synthetic).toExtend<
			(value: string, index: number, values: Array<string>) => RojoResolver
		>();
		expectTypeOf<RojoResolver["getRbxPathFromFilePath"]>().returns.toEqualTypeOf<
			RbxPath | undefined
		>();
	});
});
