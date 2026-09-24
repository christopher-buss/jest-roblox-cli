import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	dts: {
		build: true,
		generator: "oxc",
		tsconfig: "tsconfig.lib.json",
	},
	entry: ["src/index.ts", "src/testing.ts", "!src/**/*.spec.ts"],
	fixedExtension: true,
	format: ["esm"],
	publint: true,
	target: ["node24"],
});
