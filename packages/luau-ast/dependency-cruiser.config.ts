import path from "node:path";

import { createDependencyCruiserConfig } from "../../dependency-cruiser.shared.ts";

export default createDependencyCruiserConfig({
	fileSystemSeam: "packages/luau-ast/src/lute-spawner.ts",
	projectRoot: "packages/luau-ast",
	rules: [],
	sourceRoots: ["packages/luau-ast/src"],
	testRoot: "packages/luau-ast/test",
	tsConfig: path.join(import.meta.dirname, "tsconfig.json"),
});
