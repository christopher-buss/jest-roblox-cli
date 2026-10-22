import path from "node:path";

import { createDependencyCruiserConfig } from "../../dependency-cruiser.shared.ts";

const SOURCE = "packages/luau-ast/src";

export default createDependencyCruiserConfig({
	fileSystemSeam: "packages/luau-ast/src/lute-spawner.ts",
	projectRoot: "packages/luau-ast",
	rules: [
		{
			name: "pure-tree-modules-do-not-load-runtime-adapters",
			from: {
				path: `^${SOURCE}/(?:cst[^/]*|visit|source-bytes|utf-8-offsets|string-literal)[.]ts$`,
			},
			severity: "error",
			to: {
				dependencyTypesNot: ["type-only"],
				path: `^${SOURCE}/(?:parser|compiler|lute-spawner|wasm-host|wasm-runtime|compiler-wasm-runtime|luau-parser-wasm|luau-compiler-wasm)[.]ts$`,
			},
		},
		{
			name: "wasm-backends-do-not-import-language-apis",
			from: { path: `^${SOURCE}/(?:wasm-host|wasm-runtime|compiler-wasm-runtime)[.]ts$` },
			severity: "error",
			to: {
				path: `^${SOURCE}/`,
				pathNot: `^${SOURCE}/(?:wasm-host|luau-(?:parser|compiler)-wasm)[.]ts$`,
			},
		},
		...(["parser", "compiler"] as const).map((kind) => {
			return {
				name: `only-${kind}-backend-loads-embedded-${kind}`,
				from: {
					path: `^${SOURCE}/`,
					pathNot: `^${SOURCE}/${kind === "parser" ? "wasm-runtime" : "compiler-wasm-runtime"}[.]ts$`,
				},
				severity: "error" as const,
				to: { path: `^${SOURCE}/luau-${kind}-wasm[.]ts$` },
			};
		}),
		{
			name: "parser-does-not-load-compiler",
			from: { path: `^${SOURCE}/(?:parser|wasm-runtime)[.]ts$` },
			severity: "error",
			to: {
				dependencyTypesNot: ["type-only"],
				path: `^${SOURCE}/(?:compiler|compiler-wasm-runtime)[.]ts$`,
			},
		},
		{
			name: "compiler-does-not-load-parser",
			from: { path: `^${SOURCE}/(?:compiler|compiler-wasm-runtime)[.]ts$` },
			severity: "error",
			to: {
				dependencyTypesNot: ["type-only"],
				path: `^${SOURCE}/(?:parser|wasm-runtime)[.]ts$`,
			},
		},
		{
			name: "only-lute-spawner-starts-processes",
			from: { path: `^${SOURCE}/`, pathNot: `^${SOURCE}/lute-spawner[.]ts$` },
			severity: "error",
			to: { dependencyTypes: ["core"], path: "^(?:node:)?child_process$" },
		},
	],
	sourceRoots: ["packages/luau-ast/src"],
	testRoot: "packages/luau-ast/test",
	tsConfig: path.join(import.meta.dirname, "tsconfig.json"),
});
