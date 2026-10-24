import { defineConfig } from "oxlint";

import { standaloneOxlint } from "../../oxlint.shared.ts";

export default defineConfig(
	standaloneOxlint({
		name: "packages/roblox-runner",
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
