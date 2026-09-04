import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The specifier `src/coverage-pipeline/html-assets.ts` imports. Nothing on disk
 * answers it: the module is built here, from the asset files inside the
 * installed `istanbul-reports`, by whichever of the four loaders is running —
 * the two tsdown configs, vitest, or the node hook `bin/jest-roblox.js`
 * registers.
 *
 * Istanbul's html reporters copy those files out of `__dirname/assets` when
 * they write a report. That directory ships beside the reporter in
 * `node_modules`, and nowhere near the standalone binary, so the report has to
 * carry its own assets to survive being bundled (jest-roblox-cli#6).
 */
export const ISTANBUL_HTML_ASSETS_ID = "virtual:istanbul-html-assets";

/**
 * Asset directories per reporter, in the order istanbul reads them. `html`
 * flattens `vendor/` into the report directory alongside the rest, so the two
 * are one list here as well.
 */
const ASSET_DIRECTORIES = {
	"html": ["lib/html/assets", "lib/html/assets/vendor"],
	"html-spa": ["lib/html-spa/assets"],
};

export function buildIstanbulHtmlAssetsModule() {
	const require = createRequire(import.meta.url);
	const packageRoot = path.dirname(require.resolve("istanbul-reports/package.json"));

	const groups = Object.fromEntries(
		Object.entries(ASSET_DIRECTORIES).map(([reporter, directories]) => [
			reporter,
			directories.flatMap((directory) => readAssets(path.join(packageRoot, directory))),
		]),
	);

	return `export default ${JSON.stringify(groups)};`;
}

function readAssets(directory) {
	return readdirSync(directory)
		.filter((name) => statSync(path.join(directory, name)).isFile())
		.map((name) => {
			const content = readFileSync(path.join(directory, name));
			// Sniffed rather than keyed off the extension: the html assets are
			// `.css`, `.js` and `.png` today, and a future one has to land in
			// the right half without this list being remembered.
			const text = content.toString("utf-8");
			return Buffer.from(text, "utf-8").equals(content)
				? { name, text }
				: { name, base64: content.toString("base64") };
		});
}
