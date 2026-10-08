import {
	createCstEdits,
	indexSourceBytes,
	loadLuauParser,
	printCst,
	printCstMapped,
} from "@isentinel/luau-ast";
import { CST_NODE_KINDS, forEachCstNode, walkCst } from "@isentinel/luau-ast/cst";
import type { CstRoot } from "@isentinel/luau-ast/cst";

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Handwritten Luau covering comments, tabs, trailing whitespace, CRLF, every
// number and string spelling, parentheses, semicolons, interpolated strings,
// type annotations, attributes, declarations, and type functions. Byte
// identity on a zero-edit pass is the whole claim; a fixture that breaks it
// names the construct the serializer mishandles.
const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "..", "fixtures", "cst");

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

const NOT_SLOTS: ReadonlySet<string> = new Set(["binding", "location", "type"]);

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

	it("should walk every node's slots in serializer order", () => {
		expect.assertions(1);

		const written = new Set<string>();
		const listed = new Set<string>();
		for (const { fileName, source } of fixtures) {
			forEachCstNode(parseFixture(fileName, source), (node) => {
				const keys = Object.keys(node).filter((key) => !NOT_SLOTS.has(key));
				const slots: Array<string> = [];
				walkCst(node, {
					skipSlot: (owner, slot) => {
						slots.push(...[slot].filter(() => owner === node));

						return false;
					},
				});
				written.add(`${node.type}: ${keys.join()}`);
				listed.add(`${node.type}: ${slots.filter((slot) => slot in node).join()}`);
			});
		}

		expect([...written]).toStrictEqual([...listed]);
	});

	it.for(fixtures)("should print $fileName byte-identical", ({ fileName, source }) => {
		expect.assertions(1);

		const printed = printCst(parseFixture(fileName, source));

		expect(printed).toBe(source);
	});

	it.for(fixtures)("should re-parse printed $fileName", ({ fileName, source }) => {
		expect.assertions(1);

		const printed = printCst(parseFixture(fileName, source));

		expect(loadLuauParser().parse(printed).ok).toBeTrue();
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
