import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	rojoProject: "default.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "related-rbxts-e2e",
					include: ["src/**/*.spec.ts"],
					outDir: "compiled",
				},
			},
		],
	},
});
