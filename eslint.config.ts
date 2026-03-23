import isentinel from "@isentinel/eslint-config";

export default isentinel(
	{
		name: "tools/jest-roblox-cli",
		ignores: [
			"**/__fixtures__/**/*",
			"**/fixtures/**/*",
			"!./src/coverage",
			"**/out-tsc/**/*",
			"docs/**/*",
			".standalone/**/*",
			"plans/**/*",
			"reference/**/*",
		],
		jsdoc: false,
		namedConfigs: true,
		pnpm: false,
		roblox: false,
		rules: {
			"max-lines": "off",
			"max-lines-per-function": "off",
			"test/require-hook": "off",
		},
		test: {
			vitest: {
				extended: true,
				typecheck: true,
			},
		},
		type: "package",
		typescript: {
			parserOptionsTypeAware: {
				projectService: true,
			},
		},
	},
	{
		name: "project/luau-declaration",
		files: ["src/luau.d.ts"],
		rules: {
			"sonar/file-name-differ-from-class": "off",
		},
	},
	{
		name: "project/bin",
		files: ["./bin/**/*"],
		rules: {
			"antfu/no-top-level-await": "off",
		},
	},
);
