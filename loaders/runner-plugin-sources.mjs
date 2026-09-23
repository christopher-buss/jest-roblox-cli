import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The specifier `src/backends/runner-plugin.ts` imports. Nothing on
 * disk answers it: the module is built here, from the plugin's Luau source, by
 * whichever loader is running — the two tsdown configs, vitest, or the node
 * hook `bin/jest-roblox.js` registers.
 *
 * `studio-cli` builds its Managed Plugin from these files with rojo, and the
 * standalone binary has no package tree beside it to read them from, so the
 * source travels inside the bundle. Paths are relative to the package root.
 */
export const RUNNER_PLUGIN_SOURCES_ID = "virtual:runner-plugin-sources";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ROOTS = [
	"plugin/plugin.project.json",
	"plugin/src/test-in-run-mode.server.luau",
	"plugin/host",
	"luau",
];

export function buildRunnerPluginSourcesModule() {
	const sources = ROOTS.flatMap((root) => readTree(path.join(PACKAGE_ROOT, root), root));
	return `export default ${JSON.stringify(sources)};`;
}

function readTree(source, target) {
	if (statSync(source).isDirectory()) {
		return readdirSync(source)
			.toSorted()
			.flatMap((name) => readTree(path.join(source, name), path.posix.join(target, name)));
	}

	return [{ path: target, text: readFileSync(source, "utf-8") }];
}
