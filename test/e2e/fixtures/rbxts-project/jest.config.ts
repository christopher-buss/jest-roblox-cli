import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	projects: [
		{
			test: {
				displayName: "rbxts-e2e",
				include: ["src/**/*.spec.ts"],
				outDir: "out",
			},
		},
	],
	rojoProject: "default.project.json",
});
