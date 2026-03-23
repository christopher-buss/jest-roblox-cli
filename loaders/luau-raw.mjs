import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith(".luau")) {
		const resolved = await nextResolve(specifier, context);
		return { ...resolved, format: "luau-raw" };
	}

	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (context.format === "luau-raw") {
		const content = await readFile(fileURLToPath(url), "utf-8");
		return {
			format: "module",
			shortCircuit: true,
			source: `export default ${JSON.stringify(content)};`,
		};
	}

	return nextLoad(url, context);
}
