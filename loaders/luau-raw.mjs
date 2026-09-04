import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildIstanbulHtmlAssetsModule, ISTANBUL_HTML_ASSETS_ID } from "./istanbul-html-assets.mjs";

export function resolve(specifier, context, nextResolve) {
	if (specifier === ISTANBUL_HTML_ASSETS_ID) {
		return { format: "istanbul-html-assets", shortCircuit: true, url: specifier };
	}

	const resolved = nextResolve(specifier, context);

	if (resolved.url.endsWith(".luau") || resolved.url.endsWith(".lua")) {
		return { ...resolved, format: "luau-raw" };
	}

	return resolved;
}

export function load(url, context, nextLoad) {
	if (context.format === "istanbul-html-assets") {
		return {
			format: "module",
			shortCircuit: true,
			source: buildIstanbulHtmlAssetsModule(),
		};
	}

	if (context.format === "luau-raw") {
		if (url.endsWith(".lua")) {
			return {
				format: "module",
				shortCircuit: true,
				source: "export default {};",
			};
		}

		const content = readFileSync(fileURLToPath(url), "utf-8");
		return {
			format: "module",
			shortCircuit: true,
			source: `export default ${JSON.stringify(content)};`,
		};
	}

	return nextLoad(url, context);
}
