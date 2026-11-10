export default {
	luauRoots: ["src"],
	rojoProject: "test.project.json",
	test: {
		testMatch: ["**/*.spec.luau"],
		typecheck: {
			enabled: true,
		},
	},
};
