import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	projects: [
		{
			test: {
				displayName: "multi-root-e2e",
				include: ["pkg/src/**/*.spec.luau"],
			},
		},
	],
	rojoProject: "default.project.json",
});
