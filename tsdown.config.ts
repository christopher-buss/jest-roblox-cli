import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

function luauRawPlugin() {
	return {
		name: "luau-raw",
		load(id: string) {
			if (!id.endsWith(".luau")) {
				return;
			}

			const content = readFileSync(id, "utf-8");
			return `export default ${JSON.stringify(content)};`;
		},
	};
}

const SEA_STUB_MODULES = new Set(["@typescript/native-preview", "oxc-parser"]);

function seaStubPlugin() {
	return {
		name: "sea-stub",
		load(id: string) {
			if (!id.startsWith("\0sea-stub:")) {
				return;
			}

			return "module.exports = {};";
		},
		resolveId(id: string) {
			if (!SEA_STUB_MODULES.has(id)) {
				return;
			}

			return { id: `\0sea-stub:${id}`, external: false };
		},
	};
}

export default defineConfig([
	{
		clean: true,
		deps: {
			neverBundle: [
				"arktype",
				"istanbul-lib-coverage",
				"istanbul-lib-report",
				"istanbul-reports",
				"jiti",
				"typescript",
				"ws",
			],
			onlyBundle: ["@rbxts/jest", "type-fest"],
		},
		dts: {
			build: true,
			tsconfig: "tsconfig.lib.json",
		},
		entry: ["src/index.ts", "src/cli.ts", "!src/**/*.spec.ts"],
		fixedExtension: true,
		format: ["esm"],
		plugins: [luauRawPlugin()],
		publint: true,
		shims: true,
		target: ["node24"],
		unbundle: false,
	},
	{
		deps: { alwaysBundle: [/.*/] },
		entry: ["src/sea-entry.ts"],
		exe: {
			fileName: "jest-roblox",
			outDir: "dist/sea",
			seaConfig: {
				disableExperimentalSEAWarning: true,
				useCodeCache: true,
			},
		},
		format: ["cjs"],
		plugins: [seaStubPlugin(), luauRawPlugin()],
		shims: true,
		target: ["node25"],
	},
]);
