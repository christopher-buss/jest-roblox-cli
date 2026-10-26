import { defineConfig } from "oxlint";

import { standaloneOxlint } from "../../oxlint.shared.ts";

export default defineConfig(
	standaloneOxlint({
		name: "packages/rojo-utils",
		antiSlop: true,
		configDirectory: import.meta.dirname,
		ignores: ["**/out-tsc/**/*"],
		jsdoc: true,
		test: {
			vitest: {
				extended: true,
				typecheck: true,
			},
		},
		type: "package",
	}),
);
