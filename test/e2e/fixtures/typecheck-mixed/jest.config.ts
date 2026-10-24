import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	rojoProject: "default.project.json",
	test: {
		include: ["src/**/*.spec.luau"],
		typecheck: {
			enabled: true,
		},
	},
});
