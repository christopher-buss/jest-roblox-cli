import { type } from "arktype";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

const packageJsonSchema = type({
	exports: type.Record("string", type.Record("string", "string").or("string")),
});

function readConditionalExports(): Array<[string, Record<string, string>]> {
	const packageJson = packageJsonSchema.assert(
		JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")),
	);

	return Object.entries(packageJson.exports).filter(
		(entry): entry is [string, Record<string, string>] => typeof entry[1] === "object",
	);
}

describe("package exports", () => {
	it("should resolve each subpath to the same module from source and from dist", () => {
		expect.assertions(1);

		const stems = readConditionalExports().map(([subpath, conditions]) => {
			return {
				built: conditions["default"]!.replace(/^\.\/dist\/(.+)\.mjs$/, "$1"),
				source: conditions["source"]!.replace(/^\.\/src\/(.+)\.ts$/, "$1"),
				subpath,
			};
		});

		expect(stems.filter(({ built, source }) => built !== source)).toStrictEqual([]);
	});

	it("should build every source entry", () => {
		expect.assertions(1);

		const tsdownConfig = readFileSync(path.join(PACKAGE_ROOT, "tsdown.config.ts"), "utf-8");
		const missing = readConditionalExports()
			.map(([, conditions]) => conditions["source"]!.slice(2))
			.filter((source) => !tsdownConfig.includes(`"${source}"`));

		expect(missing).toStrictEqual([]);
	});
});
