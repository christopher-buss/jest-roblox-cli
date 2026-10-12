import { defineConfig } from "oxlint";

import { standaloneOxlint } from "../../oxlint.shared.ts";

export default defineConfig(
	standaloneOxlint({
		name: "packages/shared/roblox-runner",
		configDirectory: import.meta.dirname,
		ignores: ["**/out-tsc/**/*"],
		jsdoc: false,
		test: {
			vitest: {
				extended: true,
				typecheck: true,
			},
		},
		type: "package",
	}),
);
