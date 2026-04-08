import isentinel from "@isentinel/eslint-config";

export default isentinel({
	name: "packages/shared/roblox-runner",
	namedConfigs: true,
	roblox: false,
	rules: {
		"max-lines": "off",
		"max-lines-per-function": "off",
	},
	test: {
		vitest: {
			extended: false,
			typecheck: true,
		},
	},
	type: "package",
	typescript: {
		parserOptionsTypeAware: {
			projectService: true,
		},
	},
});
