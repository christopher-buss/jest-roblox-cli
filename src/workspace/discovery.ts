import * as fs from "node:fs";
import * as path from "node:path";

export const TURBO_MARKER = "turbo.json";
export const NX_MARKER = "nx.json";

const MARKERS = ["pnpm-workspace.yaml", TURBO_MARKER, NX_MARKER] as const;

export function discoverWorkspaceRoot(cwd: string): string {
	let current = path.resolve(cwd);
	while (true) {
		if (MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) {
			return current;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			throw new Error(
				"No workspace root found. Expected one of pnpm-workspace.yaml / turbo.json / nx.json above cwd.",
			);
		}

		current = parent;
	}
}
