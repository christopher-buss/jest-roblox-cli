import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	placeFile: "game.rbxl",
	rojoProject: "test.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "a",
					include: ["src/a/**/*.spec.luau"],
					outDir: "src/a",
				},
			},
			{
				test: {
					displayName: "b",
					include: ["src/b/**/*.spec.luau"],
					outDir: "src/b",
				},
			},
		],
	},
});
