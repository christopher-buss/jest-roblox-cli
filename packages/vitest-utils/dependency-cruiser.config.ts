import path from "node:path";

import { createDependencyCruiserConfig } from "../../dependency-cruiser.shared.ts";

const ROOT = "packages/vitest-utils";
const SOURCE = `${ROOT}/src`;

export default createDependencyCruiserConfig({
	fileSystemSeam: [`${SOURCE}/memory-file-system.ts`],
	projectRoot: ROOT,
	rules: [
		{
			name: "production-imports-implementation-not-barrel",
			from: {
				path: `^${SOURCE}/`,
				pathNot: "[.]spec(?:-d)?[.]ts$",
			},
			severity: "error",
			to: {
				path: `^${SOURCE}/index[.]ts$`,
			},
		},
	],
	sourceRoots: [SOURCE],
	testRoot: `${ROOT}/test`,
	tsConfig: path.join(import.meta.dirname, "tsconfig.json"),
});
