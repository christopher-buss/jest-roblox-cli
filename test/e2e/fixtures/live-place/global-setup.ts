import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

// Vitest `globalSetup` for the `live` project. Ensures rbxtsc intermediates
// (`out/`, `include/`) exist before live tests run. The CLI's multi-project
// path (`runMultiProject` in src/cli.ts) writes per-project stubs into the
// rojo source tree and rebuilds the rbxl — that rebuild needs the compiled
// Luau output and rbxts runtime to be present. Both directories are
// gitignored (regenerated artifacts), so we compile on demand.
//
// Sentinel-cached: re-runs only when `out/shared/example.luau` is missing.
// To force a clean rebuild, delete `out/` before invoking vitest.

const FIXTURE_DIR = path.resolve(import.meta.dirname);
const SENTINEL = path.join(FIXTURE_DIR, "out", "shared", "example.luau");

export default function setup(): void {
	if (existsSync(SENTINEL)) {
		return;
	}

	// `pnpm exec` resolves the rbxtsc bin shim cross-platform (Windows .CMD,
	// POSIX symlink). Direct `execFile` on `.bin/rbxtsc` fails on Windows
	// where the bin entry is a script shim, not a native executable.
	execSync("pnpm exec rbxtsc -p tsconfig.lib.json --type game", {
		cwd: FIXTURE_DIR,
		stdio: "inherit",
	});
}
