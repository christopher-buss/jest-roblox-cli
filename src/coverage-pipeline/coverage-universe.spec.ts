import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { filterCoverageUniverse } from "./coverage-universe.ts";
import type { MappedCoverageResult, MappedFileCoverage } from "./mapper.ts";

function mappedFile(filePath: string): MappedFileCoverage {
	return {
		b: {},
		branchMap: {},
		f: {},
		fnMap: {},
		path: filePath,
		s: { "0": 0 },
		statementMap: { "0": { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } } },
	};
}

function resultFor(...filePaths: Array<string>): MappedCoverageResult {
	const files: Record<string, MappedFileCoverage> = {};
	for (const filePath of filePaths) {
		files[filePath] = mappedFile(filePath);
	}

	return { files };
}

function keys(result: MappedCoverageResult): Array<string> {
	return Object.keys(result.files).sort();
}

describe(filterCoverageUniverse, () => {
	it("should drop a file matching an ignore pattern", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(
			resultFor("src/foo/index.ts", "src/foo/player.ts"),
			{
				ignore: ["**/index.ts"],
			},
		);

		expect(keys(filtered)).toStrictEqual(["src/foo/player.ts"]);
	});

	it("should match ignore patterns by substring like Jest", () => {
		expect.assertions(1);

		// `contains: true` — a bare `index.ts` matches anywhere in the path,
		// mirroring Jest's regex-based coveragePathIgnorePatterns.
		const filtered = filterCoverageUniverse(resultFor("src/foo/index.ts"), {
			ignore: ["index.ts"],
		});

		expect(keys(filtered)).toStrictEqual([]);
	});

	it("should keep files that match no ignore pattern", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/foo/init.ts"), {
			ignore: ["**/index.ts"],
		});

		expect(keys(filtered)).toStrictEqual(["src/foo/init.ts"]);
	});

	it("should keep only files matching the include globs", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/a.ts", "lib/b.ts"), {
			include: ["src/**/*.ts"],
		});

		expect(keys(filtered)).toStrictEqual(["src/a.ts"]);
	});

	it("should match slash-free include globs by basename", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(
			resultFor("src/foo/player.ts", "src/foo/enemy.ts"),
			{
				include: ["player.ts"],
			},
		);

		expect(keys(filtered)).toStrictEqual(["src/foo/player.ts"]);
	});

	it("should relativize absolute file paths against the cwd before matching", () => {
		expect.assertions(1);

		const absolutePath = path.join(process.cwd(), "src/foo/index.ts");
		const filtered = filterCoverageUniverse(resultFor(absolutePath), {
			ignore: ["**/index.ts"],
		});

		expect(keys(filtered)).toStrictEqual([]);
	});

	it("should drop files matching a negated include glob", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/a.ts", "src/a.spec.ts"), {
			include: ["src/**/*.ts", "!**/*.spec.ts"],
		});

		expect(keys(filtered)).toStrictEqual(["src/a.ts"]);
	});

	it("should drop a file that is included but also ignored", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(
			resultFor("src/foo/index.ts", "src/foo/player.ts"),
			{
				ignore: ["**/index.ts"],
				include: ["src/**/*.ts"],
			},
		);

		expect(keys(filtered)).toStrictEqual(["src/foo/player.ts"]);
	});

	it("should return every file when neither include nor ignore is given", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/a.ts", "src/b.ts"), {});

		expect(keys(filtered)).toStrictEqual(["src/a.ts", "src/b.ts"]);
	});
});
