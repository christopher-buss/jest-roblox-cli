import type { AstStat, AstStatIf } from "@isentinel/luau-ast/ast";

import { assert, describe, expect, it } from "vitest";

import { luauParser } from "../luau/parser.ts";
import type { CoverageIgnores } from "./coverage-ignore.ts";
import { resolveCoverageIgnores } from "./coverage-ignore.ts";

interface Resolved {
	ignores: CoverageIgnores;
	statements: Array<AstStat>;
}

function resolve(source: string): Resolved {
	const parsed = luauParser.parse(source);
	assert(parsed.ok);
	return {
		ignores: resolveCoverageIgnores(parsed, source),
		statements: parsed.root.body,
	};
}

function coveredLines({ ignores, statements }: Resolved): Array<number> {
	return statements
		.filter((statement) => ignores.covers(statement.location))
		.map((statement) => statement.location.beginLine);
}

function firstIf({ statements }: Resolved): AstStatIf {
	const statement = statements.find((candidate) => candidate.type === "AstStatIf");
	assert(statement?.type === "AstStatIf");
	return statement;
}

describe(resolveCoverageIgnores, () => {
	it("should cover the statement after a line directive", () => {
		expect.assertions(1);

		const resolved = resolve("local a = 1\n-- cov ignore next\nlocal b = 2\nlocal c = 3");

		expect(coveredLines(resolved)).toStrictEqual([3]);
	});

	it("should cover nothing in a file without directives", () => {
		expect.assertions(1);

		const resolved = resolve("-- a comment\nlocal a = 1");

		expect(coveredLines(resolved)).toBeEmpty();
	});

	it("should reach past other comments between the directive and its node", () => {
		expect.assertions(1);

		const resolved = resolve(
			["-- cov ignore next", "--[[ unrelated ]]", "-- reason", "local a = 1"].join("\n"),
		);

		expect(coveredLines(resolved)).toStrictEqual([4]);
	});

	it.for([
		["a block comment", "--[[ cov ignore next ]]"],
		["a leveled block comment", "--[==[ cov ignore next ]==]"],
		["a comment without inner spaces", "--cov ignore next"],
		["a trailing reason", "-- cov ignore next: unreachable"],
	])("should read %s as a directive", ([, comment]) => {
		expect.assertions(1);

		const resolved = resolve(`${comment}\nlocal a = 1`);

		expect(coveredLines(resolved)).toStrictEqual([2]);
	});

	it.for([
		["a comment that only mentions it", "-- see cov ignore next"],
		["a longer keyword", "-- cov ignore elsewhere"],
		["an unknown hint", "-- cov ignore file"],
	])("should not read %s as a directive", ([, comment]) => {
		expect.assertions(1);

		const resolved = resolve(`${comment}\nlocal a = 1`);

		expect(coveredLines(resolved)).toBeEmpty();
	});

	it("should read byte offsets past a multi-byte character", () => {
		expect.assertions(1);

		const resolved = resolve('local s = "é" -- cov ignore next\nlocal t = 1');

		expect(coveredLines(resolved)).toStrictEqual([2]);
	});

	it("should cover a tab-indented statement inside a nested block", () => {
		expect.assertions(2);

		const resolved = resolve("do\n\t-- cov ignore next\n\tlocal a = 1\n\tlocal b = 2\nend");
		const outer = resolved.statements[0]!;
		assert(outer.type === "AstStatBlock");

		expect(resolved.ignores.covers(outer.body[0]!.location)).toBeTrue();
		expect(resolved.ignores.covers(outer.body[1]!.location)).toBeFalse();
	});

	it("should cover a statement inside a function body", () => {
		expect.assertions(1);

		const resolved = resolve("local f = function()\n\t-- cov ignore next\n\treturn 1\nend");
		const local = resolved.statements[0]!;
		assert(local.type === "AstStatLocal");
		const func = local.values[0]!;
		assert(func.type === "AstExprFunction");

		expect(resolved.ignores.covers(func.body.body[0]!.location)).toBeTrue();
	});

	it("should reach past a carriage return line ending", () => {
		expect.assertions(1);

		const resolved = resolve("-- cov ignore next\r\nlocal a = 1");

		expect(coveredLines(resolved)).toStrictEqual([2]);
	});

	it("should drop a directive at the end of the file", () => {
		expect.assertions(1);

		const resolved = resolve("local a = 1\n-- cov ignore next\n");

		expect(coveredLines(resolved)).toBeEmpty();
	});

	it("should drop a directive before an elseif", () => {
		expect.assertions(2);

		const resolved = resolve("if a then\n\tf()\n-- cov ignore if\nelseif b then\n\tg()\nend");
		const node = firstIf(resolved);
		const chained = node.elsebody!;
		assert(chained.type === "AstStatIf");

		expect(resolved.ignores.covers(chained.thenbody.location)).toBeFalse();
		expect(resolved.ignores.dropsImplicitElse(node)).toBeFalse();
	});

	it("should drop a directive with code between it and the next node", () => {
		expect.assertions(1);

		const resolved = resolve(
			["do", "\tlocal a = 1", "\t-- cov ignore next", "end", "local b = 2"].join("\n"),
		);

		expect(coveredLines(resolved)).toBeEmpty();
	});

	it("should cover the then block of the next if under ignore if", () => {
		expect.assertions(3);

		const resolved = resolve("-- cov ignore if\nif a then\n\tf()\nelse\n\tg()\nend");
		const node = firstIf(resolved);

		expect(resolved.ignores.covers(node.location)).toBeFalse();
		expect(resolved.ignores.covers(node.thenbody.location)).toBeTrue();
		expect(resolved.ignores.covers(node.elsebody!.location)).toBeFalse();
	});

	it("should cover the final else block of an if chain under ignore else", () => {
		expect.assertions(3);

		const resolved = resolve(
			"-- cov ignore else\nif a then\n\tf()\nelseif b then\n\tg()\nelse\n\th()\nend",
		);
		const node = firstIf(resolved);
		const last = node.elsebody!;
		assert(last.type === "AstStatIf");

		expect(resolved.ignores.covers(last.thenbody.location)).toBeFalse();
		expect(resolved.ignores.covers(last.elsebody!.location)).toBeTrue();
		expect(resolved.ignores.dropsImplicitElse(node)).toBeFalse();
	});

	it("should drop the implicit else of an if chain under ignore else", () => {
		expect.assertions(2);

		const resolved = resolve("-- cov ignore else\nif a then\n\tf()\nelseif b then\n\tg()\nend");
		const node = firstIf(resolved);

		expect(resolved.ignores.dropsImplicitElse(node)).toBeTrue();
		expect(coveredLines(resolved)).toBeEmpty();
	});

	it.for(["if", "else"])(
		"should leave a statement that is not an if alone under ignore %s",
		(hint) => {
			expect.assertions(1);

			const resolved = resolve(`-- cov ignore ${hint}\nlocal a = 1`);

			expect(coveredLines(resolved)).toBeEmpty();
		},
	);
});
