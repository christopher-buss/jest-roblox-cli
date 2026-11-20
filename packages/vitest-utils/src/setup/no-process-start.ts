import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const STARTERS = [
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
	"fork",
	"spawn",
	"spawnSync",
] as const;

/** Replaces every `node:child_process` starter with one that throws. */
export function blockProcessStarts(): void {
	for (const name of STARTERS) {
		Object.defineProperty(childProcess, name, {
			configurable: true,
			value: () => {
				throw new Error(
					`Unit tests may not start a process (${name}). Pass a fake adapter (docs/CODING_STANDARDS.md, "Tests") or move the test to test/integration/ or test/e2e/.`,
				);
			},
			writable: true,
		});
	}

	syncBuiltinESMExports();
}

blockProcessStarts();
