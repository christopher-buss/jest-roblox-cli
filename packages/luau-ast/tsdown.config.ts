import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	dts: {
		build: true,
		generator: "oxc",
		tsconfig: "tsconfig.lib.json",
	},
	entry: {
		ast: "src/ast-types.ts",
		compiler: "src/compiler.ts",

		cst: "src/cst.ts",
		index: "src/index.ts",
		parser: "src/parser.ts",
		visit: "src/visit.ts",
	},
	fixedExtension: true,
	format: ["esm"],
	publint: true,
	target: ["node24"],
});
