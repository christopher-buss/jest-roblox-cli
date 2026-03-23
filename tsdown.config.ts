import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	dts: {
		build: true,
		tsconfig: "tsconfig.lib.json",
	},
	entry: ["src/index.ts", "src/cli.ts", "!src/**/*.spec.ts"],
	external: [
		"arktype",
		"istanbul-lib-coverage",
		"istanbul-lib-report",
		"istanbul-reports",
		"jiti",
		"typescript",
		"ws",
	],
	fixedExtension: true,
	format: ["esm"],
	inlineOnly: ["@rbxts/jest", "type-fest"],
	plugins: [
		{
			name: "luau-raw",
			load(id) {
				if (!id.endsWith(".luau")) {
					return;
				}

				const content = readFileSync(id, "utf-8");
				return `export default ${JSON.stringify(content)};`;
			},
		},
	],
	publint: true,
	shims: true,
	target: ["node24"],
	unbundle: false,
});
