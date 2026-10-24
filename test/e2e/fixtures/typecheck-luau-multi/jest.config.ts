import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	rojoProject: "default.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "alpha",
					include: ["alpha/**/*.spec.luau"],
					outDir: "alpha/out",
					typecheck: { enabled: true },
				},
			},
			{
				test: {
					displayName: "beta",
					include: ["beta/**/*.spec.luau"],
					outDir: "beta/out",
					typecheck: { enabled: true },
				},
			},
		],
	},
});
