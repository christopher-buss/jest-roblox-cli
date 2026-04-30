import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	rojoProject: "test.project.json",
	test: {
		passWithNoTests: true,
	},
});
