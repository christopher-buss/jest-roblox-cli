import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { OptionRow } from "#src/config/option-row.ts";
import { OPTION_ROWS } from "#src/config/options.ts";

const README = readFileSync(path.resolve(__dirname, "..", "..", "README.md"), "utf8");

function spellings({ cli }: OptionRow): Array<string> {
	if (cli === undefined) {
		return [];
	}

	return cli.negation === undefined
		? [`--${cli.name}`]
		: [`--${cli.name}`, `--${cli.negation.name}`];
}

function section(heading: string): string {
	const start = README.indexOf(`${heading}\n`);
	const level = heading.slice(0, heading.indexOf(" "));
	const end = README.indexOf(`\n${level} `, start + heading.length);
	return README.slice(start, end === -1 ? undefined : end);
}

function firstCells(markdown: string): Array<string> {
	return Array.from(markdown.matchAll(/^\| `([^`]+)`/gm), ([, cell]) => cell!);
}

function documented(names: Iterable<string>): Array<string> {
	const unique = new Set(names);

	return [...unique].toSorted();
}

describe("rEADME option tables", () => {
	it("should list every root config key", () => {
		expect.assertions(1);

		const listed = firstCells(section("### Root config fields")).map(
			(cell) => cell.split(".", 1)[0]!,
		);

		expect(documented(listed)).toStrictEqual(
			documented(OPTION_ROWS.filter((row) => row.location === "root").map(({ key }) => key)),
		);
	});

	it("should list every CLI flag", () => {
		expect.assertions(1);

		const listed = firstCells(section("## CLI flags")).map((cell) => /--[\w-]+/.exec(cell)![0]);
		const flags = OPTION_ROWS.flatMap(spellings);

		expect(documented(listed)).toStrictEqual(documented(flags));
	});
});
