import { defineConfig } from "@isentinel/jest-roblox";

// Bare config with no `projects`: it collapses into the multi pipeline, which
// synthesizes one project from `luauRoots` mapped through the Rojo tree
// (`buildImplicitProject`). `luauRoots` is pinned to the shared mount so the run
// resolves to exactly one project (`ReplicatedStorage/PkgShared`) and the spec
// count stays deterministic.
export default defineConfig({
	luauRoots: ["out/shared"],
	placeFile: "game.rbxl",
	rojoProject: "default.project.json",
	test: {
		setupFiles: ["./out/shared/test-setup.luau"],
	},
});
