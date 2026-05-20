import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	placeFile: "game.rbxl",
	rojoProject: "test.project.json",
	test: {
		projects: [
			// No user-authored config at `src/a` — generation produces a
			// cache stub at `.jest-roblox/cache/src/a/jest.config.luau`.
			{
				test: {
					displayName: "a",
					include: ["src/a/**/*.spec.luau"],
					outDir: "src/a",
				},
			},
			// User-authored `jest.config.luau` exists on disk at `src/b`
			// (Rojo will sync it to the mount). Per-mount FS detection via
			// `hasUserAuthoredConfig` must skip generation at this mount —
			// the user owns it.
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
