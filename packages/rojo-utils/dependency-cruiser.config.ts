import path from "node:path";

import { createDependencyCruiserConfig } from "../../dependency-cruiser.shared.ts";

const SOURCE = "packages/rojo-utils/src";

export default createDependencyCruiserConfig({
	fileSystemSeam: `${SOURCE}/file-system.ts`,
	projectRoot: "packages/rojo-utils",
	rules: [
		{
			name: "pure-mapping-does-not-import-io-or-orchestration",
			from: {
				path: `^${SOURCE}/(?:rbx-path|rojo-file-paths|tree-mapper|mount-collector|tree-node|rojo-types|mount-paths|path-mapper|project-schema)[.]ts$`,
			},
			severity: "error",
			to: {
				dependencyTypesNot: ["type-only"],
				path: `^${SOURCE}/(?:file-system|loader|rojo-tree|rojo-walker|rojo-resolver|index)[.]ts$`,
			},
		},
		{
			name: "walker-does-not-import-query-or-loader",
			from: { path: `^${SOURCE}/rojo-walker[.]ts$` },
			severity: "error",
			to: {
				path: `^${SOURCE}/(?:rojo-resolver|loader|rojo-tree|path-mapper|mount-collector|tree-mapper|index)[.]ts$`,
			},
		},
		{
			name: "tree-expansion-does-not-import-resolver-stack",
			from: { path: `^${SOURCE}/(?:loader|rojo-tree)[.]ts$` },
			severity: "error",
			to: {
				path: `^${SOURCE}/(?:rojo-walker|rojo-resolver|path-mapper|mount-collector|tree-mapper|index)[.]ts$`,
			},
		},
		{
			name: "production-imports-implementation-not-barrel",
			from: { path: `^${SOURCE}/`, pathNot: "[.]spec(?:-d)?[.]ts$" },
			severity: "error",
			to: { path: `^${SOURCE}/index[.]ts$` },
		},
	],
	sourceRoots: [SOURCE],
	testRoot: "packages/rojo-utils/test",
	tsConfig: path.join(import.meta.dirname, "tsconfig.json"),
});
