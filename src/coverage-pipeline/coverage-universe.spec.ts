import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { posixPath } from "#test/mocks/posix-path.ts";
import {
	createCoverageUniverseMatcher,
	filterCoverageUniverse,
	narrowCoverageToFiles,
	resolveUniverseAnchor,
} from "./coverage-universe.ts";
import type { MappedCoverageResult, MappedFileCoverage } from "./mapper-types.ts";

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

	it("should treat a leading bang in an ignore pattern literally", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/!generated.ts", "src/main.ts"), {
			ignore: ["!generated.ts"],
		});

		expect(keys(filtered)).toStrictEqual(["src/main.ts"]);
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

	it("should combine path and basename include globs", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(
			resultFor("src/player.ts", "lib/player.ts", "lib/enemy.ts"),
			{ include: ["src/**/*.ts", "player.ts"] },
		);

		expect(keys(filtered)).toStrictEqual(["lib/player.ts", "src/player.ts"]);
	});

	it("should relativize absolute file paths against the cwd before matching", () => {
		expect.assertions(1);

		const absolutePath = path.join(process.cwd(), "src/foo/index.ts");
		const filtered = filterCoverageUniverse(resultFor(absolutePath), {
			ignore: ["**/index.ts"],
		});

		expect(keys(filtered)).toStrictEqual([]);
	});

	it("should hand back the same result when the filter selects nothing", () => {
		expect.assertions(1);

		const result = resultFor("src/a.ts", "lib/b.ts");

		expect(filterCoverageUniverse(result, {})).toBe(result);
	});

	it("should drop files matching a negated include glob", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/a.ts", "src/a.spec.ts"), {
			include: ["src/**/*.ts", "!**/*.spec.ts"],
		});

		expect(keys(filtered)).toStrictEqual(["src/a.ts"]);
	});

	it("should treat bangs after the first include negation literally", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(resultFor("src/!generated.ts", "src/main.ts"), {
			include: ["**/*.ts", "!!generated.ts"],
		});

		expect(keys(filtered)).toStrictEqual(["src/main.ts"]);
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

	it("should match include globs against the given rootDir, not the cwd", () => {
		expect.assertions(1);

		// A package's own config writes `src/**/*.ts` for its own sources. The
		// invocation directory is the workspace root, so only the package's
		// `rootDir` can make that glob mean what its author meant.
		const packageRoot = path.join(process.cwd(), "packages/foo");
		const own = path.join(packageRoot, "src/a.ts");
		const sibling = path.join(process.cwd(), "packages/bar/src/b.ts");

		const filtered = filterCoverageUniverse(resultFor(own, sibling), {
			include: ["src/**/*.ts"],
			rootDir: packageRoot,
		});

		expect(keys(filtered)).toStrictEqual([own]);
	});

	it("should anchor on a rootDir that is absolute for another host", () => {
		expect.assertions(1);

		// A Windows `rootDir` reaching a Linux runner (or the reverse) must
		// still read as absolute: resolved per-host it would land under the cwd,
		// which no candidate path starts with, and the universe would go empty
		// while the thresholds kept passing vacuously.
		const packageRoot = "D:/repo/packages/foo";
		const own = "D:/repo/packages/foo/src/a.ts";
		const sibling = "D:/repo/packages/bar/src/b.ts";

		const filtered = filterCoverageUniverse(resultFor(own, sibling), {
			include: ["src/**/*.ts"],
			rootDir: packageRoot,
		});

		expect(keys(filtered)).toStrictEqual([own]);
	});

	it("should return every file when neither include nor ignore is given", () => {
		expect.assertions(1);

		const filtered = filterCoverageUniverse(
			resultFor("src/a.ts", "src/b.ts", "src/unlisted.ts"),
			{},
		);

		expect(keys(filtered)).toStrictEqual(["src/a.ts", "src/b.ts", "src/unlisted.ts"]);
	});
});

function missingRealpath(file: string): string {
	throw new Error(`ENOENT: ${file}`);
}

describe(narrowCoverageToFiles, () => {
	it("should keep only the named files, keyed absolute or cwd-relative", () => {
		expect.assertions(1);

		const absolute = path.join(process.cwd(), "src/absolute.ts");
		const narrowed = narrowCoverageToFiles({
			files: [
				absolute.replaceAll("\\", "/"),
				path.join(process.cwd(), "src/relative.ts"),
				path.join(process.cwd(), "src/deleted.ts"),
			],
			mapped: resultFor(absolute, "src/relative.ts", "src/untouched.ts"),
			realpath: missingRealpath,
		});

		expect(keys(narrowed)).toStrictEqual([absolute, "src/relative.ts"].sort());
	});

	it("should match a named file and a key that spell one real path two ways", () => {
		expect.assertions(1);

		const narrowed = narrowCoverageToFiles({
			files: ["D:/Repo/src/changed.ts"],
			mapped: resultFor("d:/repo/src/changed.ts", "d:/repo/src/untouched.ts"),
			realpath: (file) => file.toLowerCase(),
		});

		expect(keys(narrowed)).toStrictEqual(["d:/repo/src/changed.ts"]);
	});

	it("should keep no file when no named file is in the universe", () => {
		expect.assertions(1);

		const narrowed = narrowCoverageToFiles({
			files: [path.join(process.cwd(), "src/a.spec.ts")],
			mapped: resultFor("src/a.ts"),
			realpath: missingRealpath,
		});

		expect(keys(narrowed)).toStrictEqual([]);
	});
});

describe(createCoverageUniverseMatcher, () => {
	it("should make absent and empty ignore lists select the same files", () => {
		expect.assertions(1);

		const withoutIgnore = createCoverageUniverseMatcher({ include: ["src/**/*.ts"] });
		const withEmptyIgnore = createCoverageUniverseMatcher({
			ignore: [],
			include: ["src/**/*.ts"],
		});

		expect([withoutIgnore("src/a.ts"), withEmptyIgnore("src/a.ts")]).toStrictEqual([
			true,
			true,
		]);
	});

	it("should apply empty, path, basename, negated, and ignore patterns exactly", () => {
		expect.assertions(1);

		const cases = [
			{ filePath: "src/a.ts", filter: {}, included: true },
			{ filePath: "src/a.ts", filter: { include: [] }, included: true },
			{ filePath: "src/a.ts", filter: { ignore: [] }, included: true },
			{ filePath: "src/a.ts", filter: { include: ["src/**/*.ts"] }, included: true },
			{ filePath: "lib/a.ts", filter: { include: ["src/**/*.ts"] }, included: false },
			{ filePath: "src/a.ts", filter: { include: ["a.ts"] }, included: true },
			{ filePath: "src/a.ts", filter: { include: ["b.ts"] }, included: false },
			{
				filePath: "src/a.spec.ts",
				filter: { include: ["src/**/*.ts", "!**/*.spec.ts"] },
				included: false,
			},
			{
				filePath: "src/a.ts",
				filter: { include: ["src/**/*.ts", "!**/*.spec.ts"] },
				included: true,
			},
			{ filePath: "src/index.ts", filter: { ignore: ["index.ts"] }, included: false },
			{ filePath: "src/main.ts", filter: { ignore: ["index.ts"] }, included: true },
		];

		expect(
			cases.map(({ filePath, filter, included }) => {
				return {
					actual: createCoverageUniverseMatcher(filter)(filePath),
					expected: included,
					filePath,
				};
			}),
		).toStrictEqual(
			cases.map(({ filePath, included }) => {
				return {
					actual: included,
					expected: included,
					filePath,
				};
			}),
		);
	});
});

describe(resolveUniverseAnchor, () => {
	/**
	 * The anchor as a plain string, so an assertion can name one.
	 * @param rootDirectory - The configured rootDir, if any.
	 * @returns The resolved anchor.
	 */
	function anchorFor(rootDirectory?: string): string {
		return resolveUniverseAnchor(rootDirectory);
	}

	it("should keep a windows absolute rootDir whole on any host", () => {
		expect.assertions(1);

		expect(anchorFor("D:\\repo\\packages\\foo")).toBe("D:/repo/packages/foo");
	});

	it("should keep a posix absolute rootDir whole", () => {
		expect.assertions(1);

		expect(anchorFor("/repo/packages/foo")).toBe("/repo/packages/foo");
	});

	it("should drop a trailing slash so the anchor is a clean prefix", () => {
		expect.assertions(1);

		expect(anchorFor("/repo/packages/foo/")).toBe("/repo/packages/foo");
	});

	it("should read a relative rootDir against the cwd", () => {
		expect.assertions(1);

		expect(anchorFor("packages/foo")).toBe(
			path.posix.join(posixPath(process.cwd()), "packages/foo"),
		);
	});
});
