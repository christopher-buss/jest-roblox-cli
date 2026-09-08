import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { printCst } from "./cst-print.ts";
import type { CstRoot } from "./cst.ts";
import { loadLuauParser } from "./parser.ts";

// Handwritten Luau covering comments, tabs, trailing whitespace, CRLF, every
// number and string spelling, parentheses, semicolons, interpolated strings,
// and type annotations. Byte identity on a zero-edit pass is the whole claim;
// a fixture that breaks it names the construct the serializer mishandles.
const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "..", "test", "fixtures", "cst");

const fixtures = fs
	.readdirSync(FIXTURE_DIRECTORY)
	.filter((entry) => entry.endsWith(".luau"))
	.sort()
	.map((fileName) => {
		return {
			fileName,
			source: fs.readFileSync(path.join(FIXTURE_DIRECTORY, fileName), "utf8"),
		};
	});

function parseFixture(fileName: string, source: string): CstRoot {
	const result = loadLuauParser().parseCst({ fileName, source });
	if (!result.ok) {
		throw new Error(result.errors.join("\n"));
	}

	return result.root;
}

describe("fidelity fixtures", () => {
	it("should have a CRLF fixture", () => {
		expect.assertions(1);

		const crlf = fixtures.find((fixture) => fixture.fileName === "crlf.luau");

		expect(crlf!.source).toContain("\r\n");
	});

	it.for(fixtures)("should print $fileName byte-identical", ({ fileName, source }) => {
		expect.assertions(1);

		const printed = printCst(parseFixture(fileName, source));

		expect(printed).toBe(source);
	});

	it.for(fixtures)("should re-parse printed $fileName", ({ fileName, source }) => {
		expect.assertions(1);

		const printed = printCst(parseFixture(fileName, source));

		expect(loadLuauParser().parse(printed).ok).toBe(true);
	});
});
