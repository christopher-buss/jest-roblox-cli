export default {
	rojoProject: "test.project.json",
	test: {
		passWithNoTests: true,
		// Non-default so a run that dropped the budget on the way to the wire
		// cannot pass by matching the default anyway.
		projectTimeout: 12_000,
		projects: [
			{
				test: {
					displayName: "@e2e/nested",
					include: ["out-test/src/**/*.spec.luau"],
					outDir: "out-test/src",
				},
			},
		],
	},
};
