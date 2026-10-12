import { defineConfig, type OxlintConfig } from "oxlint";

import { standaloneOxlint } from "./oxlint.shared.ts";

export default defineConfig<OxlintConfig>({
	...standaloneOxlint(
		{
			name: "tools/jest-roblox-cli",
			configDirectory: import.meta.dirname,
			ignores: [
				"**/__fixtures__/**/*",
				"**/fixtures/**/*",
				"**/out-tsc/**/*",
				"docs/**/*",
				".standalone/**/*",
				"plans/**/*",
				"reference/**/*",
				"reports/mutation/**/*",
				"reports/stryker-incremental.json",
				"spike/**/*",
			],
			jsdoc: false,
			rules: {
				"max-lines": "off",
			},
			test: {
				vitest: {
					extended: true,
					typecheck: true,
				},
			},
			type: "package",
			unicorn: {
				nameReplacements: { configuration: false, expr: false, stmt: false, stmts: false },
			},
		},
		{
			name: "project/e2e",
			files: ["test/e2e/**/*"],
			rules: {
				"vitest/max-expects": "off",
			},
		},
		{
			name: "project/e2e-global-setup",
			files: ["test/e2e/global-setup.ts"],
			rules: {
				"import/no-default-export": "off",
			},
		},
	),
	options: {
		typeAware: true,
		typeCheck: false,
	},
});
