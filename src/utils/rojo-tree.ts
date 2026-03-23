import type { RojoTreeNode } from "../types/rojo.ts";

export function collectPaths(node: RojoTreeNode, result: Array<string>): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			result.push(value.replaceAll("\\", "/"));
		} else if (typeof value === "object" && !Array.isArray(value) && !key.startsWith("$")) {
			collectPaths(value as RojoTreeNode, result);
		}
	}
}
