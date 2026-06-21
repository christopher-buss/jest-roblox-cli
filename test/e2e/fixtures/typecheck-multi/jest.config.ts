import { defineConfig } from "@isentinel/jest-roblox";

// Multi (projects) mode with two projects, each owning its own
// `tsconfig.typetest.json`. The two distinct tsconfigs make the typecheck pass
// group per project — `alpha` is checked against its tsconfig, `beta` against
// its own — and the merged result carries both. `beta` holds a deliberate type
// error so the failing-run assertions have an attribution to surface; `alpha`
// stays clean so `--project alpha` exercises the all-pass path. Pure-local tsgo
// under `--typecheckOnly`: no compiled `out` tree, no rojo build, no Open Cloud.
export default defineConfig({
	rojoProject: "default.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "alpha",
					include: ["alpha/**/*.spec.ts"],
					outDir: "alpha/out",
					typecheck: {
						enabled: true,
						tsconfig: "alpha/tsconfig.typetest.json",
					},
				},
			},
			{
				test: {
					displayName: "beta",
					include: ["beta/**/*.spec.ts"],
					outDir: "beta/out",
					typecheck: {
						enabled: true,
						tsconfig: "beta/tsconfig.typetest.json",
					},
				},
			},
		],
	},
});
