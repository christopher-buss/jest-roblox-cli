import isentinel from "@isentinel/eslint-config";

export default isentinel({
	name: "packages/shared/rojo-utils",
	jsdoc: false,
	namedConfigs: true,
	roblox: false,
	rules: {
		"max-classes-per-file": "off",
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
