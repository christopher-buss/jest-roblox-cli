import { defineConfig } from "@isentinel/jest-roblox";

// Single mode: no `projects` array. Type Tests are enabled via config here, so
// `--typecheckOnly` only needs to supply the runtime-skip. Pure-local tsgo — no
// rojo, no Open Cloud — so this fixture carries no compiled `out` tree.
export default defineConfig({
	rojoProject: "default.project.json",
	test: {
		include: ["src/**/*.spec.ts"],
		typecheck: {
			enabled: true,
			tsconfig: "tsconfig.typetest.json",
		},
	},
});
