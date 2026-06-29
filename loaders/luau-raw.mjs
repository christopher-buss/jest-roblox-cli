import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolve(specifier, context, nextResolve) {
	const resolved = nextResolve(specifier, context);

	if (resolved.url.endsWith(".luau") || resolved.url.endsWith(".lua")) {
		return { ...resolved, format: "luau-raw" };
	}

	return resolved;
}

export function load(url, context, nextLoad) {
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
