import { defineConfig } from "oxlint";

import { standaloneOxlint } from "../../oxlint.shared.ts";

export default defineConfig(
	standaloneOxlint({
		name: "packages/shared/rojo-utils",
		configDirectory: import.meta.dirname,
		ignores: ["**/out-tsc/**/*"],
		jsdoc: false,
		test: {
			vitest: {
				extended: false,
				typecheck: true,
			},
		},
		type: "package",
	}),
);
