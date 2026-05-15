export default {
	rojoProject: "test.project.json",
	test: {
		passWithNoTests: true,
		projects: [
			{
				test: {
					displayName: "@e2e/empty-tests",
					include: ["out-test/src/**/*.spec.luau"],
					outDir: "out-test/src",
				},
			},
		],
	},
};
