export default {
	luauRoots: ["src"],
	rojoProject: "test.project.json",
	test: {
		passWithNoTests: true,
		projects: [
			{
				test: {
					displayName: "@e2e/vendored-mount",
					include: ["src/**/*.spec.luau"],
				},
			},
		],
	},
};
