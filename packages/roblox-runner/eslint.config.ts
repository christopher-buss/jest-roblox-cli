import { isentinel } from "@isentinel/eslint-config";

export default isentinel({
	name: "packages/shared/roblox-runner",
	jsdoc: false,
	namedConfigs: true,
	naming: true,
	oxlint: "native",
	roblox: false,
	rules: {
		"flawless/no-redundant-type-annotation": "off",
		"flawless/no-shared-mocks": "off",
		"flawless/prefer-mock-throw": "off",
		"flawless/prefer-vitest-local-context": "off",
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
