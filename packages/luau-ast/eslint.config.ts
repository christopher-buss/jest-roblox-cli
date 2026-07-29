import isentinel from "@isentinel/eslint-config";

export default isentinel({
	name: "packages/luau-ast",
	jsdoc: false,
	namedConfigs: true,
	naming: true,
	roblox: false,
	rules: {
		"package-json/restrict-private-properties": "off",
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
	// `AstExpr*` mirror Luau's own AST node names — keep the vocabulary.
	unicorn: {
		nameReplacements: { expr: false },
	},
});
