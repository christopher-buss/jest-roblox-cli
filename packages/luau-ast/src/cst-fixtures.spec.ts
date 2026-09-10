import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createCstEdits } from "./cst-edit.ts";
import { printCst, printCstMapped } from "./cst-print.ts";
import { CST_NODE_KINDS, forEachCstNode } from "./cst.ts";
import type { CstRoot } from "./cst.ts";
import { loadLuauParser } from "./parser.ts";
import { indexSourceBytes } from "./source-bytes.ts";

// Handwritten Luau covering comments, tabs, trailing whitespace, CRLF, every
// number and string spelling, parentheses, semicolons, interpolated strings,
// type annotations, attributes, declarations, and type functions. Byte
// identity on a zero-edit pass is the whole claim; a fixture that breaks it
// names the construct the serializer mishandles.
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

	it("should exercise every node kind the serializer emits", () => {
		expect.assertions(1);

		const seen = new Set<string>();
		for (const { fileName, source } of fixtures) {
			forEachCstNode(parseFixture(fileName, source), (node) => {
				seen.add(node.type);
			});
		}

		expect(seen).toStrictEqual(new Set(CST_NODE_KINDS));
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

describe("fidelity fixtures through the edit printer", () => {
	it.for(fixtures)(
		"should print $fileName byte-identical with an empty edit ledger and a map",
		({ fileName, source }) => {
			expect.assertions(1);

			const printed = printCstMapped(parseFixture(fileName, source), {
				edits: createCstEdits(),
				source: indexSourceBytes(source),
			});

			expect(printed.code).toBe(source);
		},
	);
});
