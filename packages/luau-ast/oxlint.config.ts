import { defineConfig } from "oxlint";

import { standaloneOxlint } from "../../oxlint.shared.ts";

export default defineConfig(
	standaloneOxlint({
		name: "packages/luau-ast",
		antiSlop: false,
		configDirectory: import.meta.dirname,
		ignores: ["**/out-tsc/**/*", "src/luau-compiler-wasm.ts", "src/luau-parser-wasm.ts"],
		jsdoc: true,
		test: {
			vitest: {
				extended: true,
				typecheck: true,
			},
		},
		type: "package",
		unicorn: {
			nameReplacements: { expr: false },
		},
	}),
);
