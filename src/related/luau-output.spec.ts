import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { readingVolume } from "#test/mocks/volume-tsconfig-reader.ts";
import { createLuauOutputResolver } from "./luau-output.ts";

const ROOT = path.resolve("/repo");

function at(relativePath: string): string {
	return path.join(ROOT, relativePath);
}

function outputOf({
	file,
	files,
}: {
	file: string;
	files: Record<string, string>;
}): string | undefined {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(Object.entries(files).map(([name, source]) => [at(name), source])),
	);
	const resolve = createLuauOutputResolver({
		fileSystem,
		tsconfigReader: readingVolume(fileSystem),
	});
	return resolve(at(file));
}

const TSCONFIG = JSON.stringify({ compilerOptions: { outDir: "out", rootDir: "src" } });

describe(createLuauOutputResolver, () => {
	it("should map a source file to the module its tsconfig compiles it to", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "app/src/shared/util.ts",
			files: {
				"app/out/shared/util.luau": "return {}",
				"app/src/shared/util.ts": "export {}",
				"app/tsconfig.json": TSCONFIG,
			},
		});

		expect(output).toBe(at("app/out/shared/util.luau"));
	});

	it("should map an index file to its init module", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "app/src/feature/index.ts",
			files: {
				"app/out/feature/init.luau": "return {}",
				"app/src/feature/index.ts": "export {}",
				"app/tsconfig.json": TSCONFIG,
			},
		});

		expect(output).toBe(at("app/out/feature/init.luau"));
	});

	it("should map through the tsconfig nearest the file, not the run root", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "packages/lib/src/thing.ts",
			files: {
				"packages/lib/build/thing.luau": "return {}",
				"packages/lib/src/thing.ts": "export {}",
				"packages/lib/tsconfig.json": JSON.stringify({
					compilerOptions: { outDir: "build", rootDir: "src" },
				}),
				"tsconfig.json": TSCONFIG,
			},
		});

		expect(output).toBe(at("packages/lib/build/thing.luau"));
	});

	it("should skip a tsconfig whose output holds no Luau module", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "app/src/util.ts",
			files: {
				"app/out/util.luau": "return {}",
				"app/src/util.ts": "export {}",
				"app/tsconfig.json": JSON.stringify({
					compilerOptions: { outDir: "out-tsc", rootDir: "src" },
				}),
				"app/tsconfig.lib.json": TSCONFIG,
			},
		});

		expect(output).toBe(at("app/out/util.luau"));
	});

	it("should map a file with no compiled module to nothing", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "app/src/types.ts",
			files: { "app/src/types.ts": "export {}", "app/tsconfig.json": TSCONFIG },
		});

		expect(output).toBeUndefined();
	});

	it("should map a file outside the tsconfig root to nothing", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "app/scripts/build.ts",
			files: {
				"app/scripts/build.luau": "return {}",
				"app/scripts/build.ts": "export {}",
				"app/tsconfig.json": TSCONFIG,
			},
		});

		expect(output).toBeUndefined();
	});

	it("should map a file with no tsconfig above it to nothing", () => {
		expect.assertions(1);

		const output = outputOf({
			file: "app/src/util.ts",
			files: { "app/out/util.luau": "return {}", "app/src/util.ts": "export {}" },
		});

		expect(output).toBeUndefined();
	});
});
