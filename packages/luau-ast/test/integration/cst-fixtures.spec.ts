import {
	createCstEdits,
	indexCst,
	indexSourceBytes,
	loadLuauParser,
	printCst,
	printCstMapped,
} from "@isentinel/luau-ast";
import {
	CST_NODE_KINDS,
	forEachCstNode,
	forEachToken,
	tokenBounds,
	walkCst,
} from "@isentinel/luau-ast/cst";
import type { CstNode, CstRoot, CstWalker, Token, TokenBounds } from "@isentinel/luau-ast/cst";

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

interface IndexedFacts {
	readonly bounds: ReadonlyArray<TokenBounds | undefined>;
	readonly kinds: ReadonlyArray<ReadonlyArray<CstNode>>;
	readonly nodes: ReadonlyArray<CstNode>;
	readonly parents: ReadonlyArray<CstNode | undefined>;
	readonly tokens: ReadonlyArray<Token>;
	readonly walk: ReadonlyArray<string>;
}

function parseFixture(fileName: string, source: string): CstRoot {
	const result = loadLuauParser().parseCst({ fileName, source });
	if (!result.ok) {
		throw new Error(result.errors.join("\n"));
	}

	return result.root;
}

function walkedBounds(node: CstNode): TokenBounds | undefined {
	const tokens: Array<Token> = [];
	forEachToken(node, (token) => {
		tokens.push(token);
	});
	const [first] = tokens;
	const last = tokens.at(-1);
	return first === undefined || last === undefined ? undefined : { first, last };
}

function walkEvents(walk: (walker: CstWalker) => void): Array<string> {
	const events: Array<string> = [];
	walk({
		onExit: (node) => {
			events.push(`exit ${node.type}`);
		},
		onNode: (node) => {
			events.push(`enter ${node.type}`);
			return node.type === "FunctionBody";
		},
	});
	return events;
}

function walkedFacts(root: CstRoot): IndexedFacts {
	const nodes: Array<CstNode> = [];
	const parents: Array<CstNode | undefined> = [];
	const open: Array<CstNode> = [];
	walkCst(root, {
		onExit: () => {
			open.pop();
		},
		onNode: (node) => {
			nodes.push(node);
			parents.push(open.at(-1));
			open.push(node);
			return false;
		},
	});
	const tokens: Array<Token> = [];
	forEachToken(root, (token) => {
		tokens.push(token);
	});
	return {
		bounds: nodes.map((node) => tokenBounds(node)),
		kinds: CST_NODE_KINDS.map((kind) => nodes.filter((node) => node.type === kind)),
		nodes,
		parents,
		tokens,
		walk: walkEvents((walker) => {
			walkCst(root, walker);
		}),
	};
}

function indexedFacts(root: CstRoot): IndexedFacts {
	const index = indexCst(root);
	return {
		bounds: index.nodes.map((node) => index.boundsOf(node)),
		kinds: CST_NODE_KINDS.map((kind) => index.ofKind(kind)),
		nodes: index.nodes,
		parents: index.nodes.map((node) => index.parentOf(node)),
		tokens: index.tokens,
		walk: walkEvents((walker) => {
			index.walk(root, walker);
		}),
	};
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

	it.for(fixtures)(
		"should bound every node in $fileName by the first and last token it walks",
		({ fileName, source }) => {
			expect.assertions(1);

			const bounds: Array<TokenBounds | undefined> = [];
			const walked: Array<TokenBounds | undefined> = [];
			forEachCstNode(parseFixture(fileName, source), (node) => {
				bounds.push(tokenBounds(node));
				walked.push(walkedBounds(node));
			});

			expect(bounds).toStrictEqual(walked);
		},
	);

	it.for(fixtures)(
		"should index every node and token in $fileName as the walk reaches them",
		({ fileName, source }) => {
			expect.assertions(1);

			const root = parseFixture(fileName, source);

			expect(indexedFacts(root)).toStrictEqual(walkedFacts(root));
		},
	);

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
