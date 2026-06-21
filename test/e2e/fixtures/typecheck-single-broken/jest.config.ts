import { defineConfig } from "@isentinel/jest-roblox";

// Single mode, but Type Tests are NOT enabled in config — `--typecheckOnly`
// (which implies `enabled`) is the entry point that turns them on. This fixture
// carries a deliberate type error so the failing-run assertions have something
// to surface. Its dedicated `tsconfig.typetest.json` keeps the error out of the
// CLI's own compile (same containment the other typecheck fixtures rely on).
export default defineConfig({
	rojoProject: "default.project.json",
	test: {
		include: ["src/**/*.spec.ts"],
		typecheck: {
			tsconfig: "tsconfig.typetest.json",
		},
	},
});
