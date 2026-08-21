import { readFileSync } from "node:fs";
import { defineConfig, type ExportsOptions } from "tsdown";

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

// cspell:ignore giget
const SEA_STUB_MODULES = new Set(["@typescript/native-preview", "giget", "oxc-parser"]);

type ExportsMap = Parameters<
	Extract<NonNullable<ExportsOptions["customExports"]>, (...args: never) => void>
>[0];

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

function sortExports(exportsMap: ExportsMap): ExportsMap {
	const collator = new Intl.Collator();
	const sorted = Object.entries(exportsMap).toSorted(([a], [b]) => {
		if (a === ".") {
			return -1;
		}

		if (b === ".") {
			return 1;
		}

		return collator.compare(a, b);
	});
	return Object.fromEntries(sorted);
}

function isConditionalExport(entry: unknown): entry is Record<string, string> {
	return typeof entry === "object" && entry !== null;
}

// tsdown derives `.` from the `src/index.ts` entry. Both subpaths ship the same
// dist chunk, but their `source` conditions differ: `.` resolves to the slim
// `source.ts` barrel so a workspace consumer typechecking from source never
// pulls the CLI's `.luau` graph, and `./artifacts` opts into the full producer
// API (`prepareArtifacts`, `loadConfig`, …) for the consumers that need it.
function customizeExports(exportsMap: ExportsMap): ExportsMap {
	const root: unknown = exportsMap["."];
	return sortExports({
		...exportsMap,
		".": isConditionalExport(root) ? { ...root, source: "./src/source.ts" } : root,
		"./artifacts": root,
	});
}

export default defineConfig([
	{
		clean: true,
		deps: {
			alwaysBundle: ["@isentinel/luau-ast"],
			neverBundle: [
				"@bedrock-rbx/ocale",
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
		exports: {
			customExports: customizeExports,
			devExports: "source",
			inlinedDependencies: false,
		},
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
		outDir: "dist/sea",
		plugins: [seaStubPlugin(), luauRawPlugin()],
		shims: true,
		target: ["node25"],
	},
]);
