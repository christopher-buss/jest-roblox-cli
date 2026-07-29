import isentinel from "@isentinel/eslint-config";

export default isentinel({
	name: "packages/shared/roblox-runner",
	jsdoc: false,
	namedConfigs: true,
	naming: true,
	roblox: false,
	rules: {
		"package-json/restrict-private-properties": "off",
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
});
