export default {
	rojoProject: "test.project.json",
	test: {
		testMatch: ["**/*.spec.ts"],
		typecheck: {
			enabled: true,
			tsconfig: "tsconfig.typetest.json",
		},
	},
};
