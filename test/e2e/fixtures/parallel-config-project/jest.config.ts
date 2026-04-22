import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	parallel: 4,
	projects: [
		{
			test: {
				displayName: "parallel-config-e2e",
				include: ["src/**/*.spec.luau"],
			},
		},
	],
	rojoProject: "default.project.json",
});
