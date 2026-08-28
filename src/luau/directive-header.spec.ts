import { assert, describe, expect, it } from "vitest";

import { countLinesThroughLastDirective } from "./directive-header.ts";
import { luauParser } from "./parser.ts";

/** Every shape the scanner and the parser have to agree on. */
const SHAPES = [
	"--!strict\n--!native\nlocal x = 1",
	"local x = 1\n--!native",
	"--!strict\n\n--!native\nlocal x = 1",
	"--!strict\n-- why native\n--!native\nlocal x = 1",
	"--!strict\n--[[ why\nnative ]]\n--!native\nlocal x = 1",
	"--!strict\n\t--!native\nlocal x = 1",
	"--!strict\n--[[ note ]] local x = 1",
	"--[==[ a ]==]\n--!native\nlocal x = 1",
	"-- plain header\nlocal x = 1",
	"--!strict\n--!native\n",
] as const;

/**
 * The same answer read off Luau's own parse: the last `--!` comment that
 * still opens the file, where "opens" means no statement has started yet.
 * Luau decides this on tokens, and only a parse knows where the first one is.
 */
function parsedDirectiveLines(source: string): number {
	const parsed = luauParser.parse(source);
	assert(parsed.ok, "fixture must parse");

	const lines = source.split("\n");
	const [firstStatement] = parsed.root.body;
	const firstTokenLine = firstStatement?.location.beginLine ?? Infinity;

	let throughLine = 0;
	for (const comment of parsed.comments) {
		const { beginColumn, beginLine } = comment.location;
		if (comment.type !== "Comment" || beginLine >= firstTokenLine) {
			continue;
		}

		if (lines[beginLine - 1]!.slice(beginColumn - 1).startsWith("--!")) {
			throughLine = comment.location.endLine;
		}
	}

	return throughLine;
}

function countFor(source: string): number {
	return countLinesThroughLastDirective(source.split("\n"));
}

describe(countLinesThroughLastDirective, () => {
	it("should count the directives that open the file", () => {
		expect.assertions(1);

		expect(countFor("--!strict\n--!native\nlocal x = 1")).toBe(2);
	});

	it("should count nothing when the file opens on code", () => {
		expect.assertions(1);

		expect(countFor("local x = 1\n--!native")).toBe(0);
	});

	it("should count past a blank line, which Luau lexes away", () => {
		expect.assertions(1);

		expect(countFor("--!strict\n\n--!native\nlocal x = 1")).toBe(3);
	});

	it("should count past a comment between two directives", () => {
		expect.assertions(2);

		expect(countFor("--!strict\n-- why native\n--!native\nlocal x = 1")).toBe(3);
		expect(countFor("--!strict\n--[[ why\nnative ]]\n--!native\nlocal x = 1")).toBe(4);
	});

	it("should count a directive that carries leading whitespace", () => {
		expect.assertions(1);

		expect(countFor("--!strict\n\t--!native\nlocal x = 1")).toBe(2);
	});

	it("should count no further than the last directive", () => {
		expect.assertions(2);

		// The trailing comments carry nothing Luau reads, so injected code is
		// welcome above them.
		expect(countFor("--!strict\n-- trailing note\nlocal x = 1")).toBe(1);
		expect(countFor("-- plain header\nlocal x = 1")).toBe(0);
	});

	it("should stop at code that follows a block comment on one line", () => {
		expect.assertions(1);

		expect(countFor("--!strict\n--[[ note ]] local x = 1")).toBe(1);
	});

	it("should read a long-bracket comment to its own closer", () => {
		expect.assertions(2);

		// `]]` closes nothing while the opener asked for `]=]`, so the
		// `--!native` is still inside the comment and is no directive.
		expect(countFor("--[=[ ]] --!native\nstill inside ]=]\nlocal x = 1")).toBe(0);
		expect(countFor("--[==[ a ]==]\n--!native\nlocal x = 1")).toBe(2);
	});

	it("should find no directive inside a block comment that never closes", () => {
		expect.assertions(1);

		expect(countLinesThroughLastDirective(["--[[ open", "--!native", "local x = 1"])).toBe(0);
	});

	it("should end a comment on a bare carriage return, as the lexer does", () => {
		expect.assertions(3);

		// The premise, straight from the parser: `\r` closes the comment but
		// is no line break, so `local x = 1` is code on line 1.
		const parsed = luauParser.parse("--!strict\rlocal x = 1");
		assert(parsed.ok, "carriage-return source must parse");

		expect(parsed.root.body[0]!.location.beginLine).toBe(1);
		// Counting the line would carry the code above the preamble with it.
		expect(countLinesThroughLastDirective(["--!strict\rlocal x = 1"])).toBe(0);
		expect(countLinesThroughLastDirective(["--!strict\r--!native", "local x = 1"])).toBe(1);
	});

	it("should count nothing in an empty file", () => {
		expect.assertions(1);

		expect(countLinesThroughLastDirective([])).toBe(0);
	});

	it("should agree with the Luau parser on every shape", () => {
		expect.assertions(1);

		expect(SHAPES.map(countFor)).toStrictEqual(SHAPES.map(parsedDirectiveLines));
	});
});
