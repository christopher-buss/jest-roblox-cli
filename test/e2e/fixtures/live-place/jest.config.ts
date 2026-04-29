import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	placeFile: "game.rbxl",
	rojoProject: "default.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "live-place-shared",
					include: ["src/shared/**/*.spec.ts"],
					outDir: "out/shared",
					setupFiles: ["./out/shared/test-setup.luau"],
				},
			},
			{
				test: {
					displayName: "live-place-server",
					include: ["src/server/**/*.spec.ts"],
					outDir: "out/server",
					setupFiles: ["./out/shared/test-setup.luau"],
				},
			},
		],
	},
});
