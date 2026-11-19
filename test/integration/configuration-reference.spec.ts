import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

import { OPTION_ROWS } from "#src/config/options.ts";

const REFERENCE = readFileSync(
	path.resolve(
		__dirname,
		"..",
		"..",
		"skills",
		"jest-roblox-cli",
		"references",
		"configuration.md",
	),
	"utf8",
);

function section(heading: string): string {
	const start = REFERENCE.indexOf(`${heading}\n`);
	const end = REFERENCE.indexOf("\n## ", start + heading.length);
	return REFERENCE.slice(start, end === -1 ? undefined : end);
}

function firstCells(markdown: string): Array<string> {
	return Array.from(markdown.matchAll(/^\| `([^`]+)`/gm), ([, cell]) => cell!);
}

function documented(names: Iterable<string>): Array<string> {
	const unique = new Set(names);

	return [...unique].toSorted();
}

function beforeFirstDot(cell: string): string {
	const dot = cell.indexOf(".");
	return dot === -1 ? cell : cell.slice(0, dot);
}

describe("configuration reference tables", () => {
	it("should list every root config key", ({ expect }) => {
		expect.assertions(1);

		const listed = firstCells(section("## Root Fields")).map(beforeFirstDot);

		expect(documented(listed)).toStrictEqual(
			documented(OPTION_ROWS.filter((row) => row.location === "root").map(({ key }) => key)),
		);
	});

	it("should list every test config key", ({ expect }) => {
		expect.assertions(1);

		const listed = [
			...firstCells(section("## Test Fields")),
			...firstCells(section("## Coverage Fields")),
		];

		expect(documented(listed)).toStrictEqual(
			documented(
				OPTION_ROWS.filter(({ location }) => {
					return ["project", "test-global", "test-shared"].includes(location);
				}).map(({ key }) => key),
			),
		);
	});
});
