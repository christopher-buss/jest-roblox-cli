import assert from "node:assert";
import { describe, expect, it } from "vitest";

import { luauParser } from "../luau/parser.ts";
import { applyLuauExpectErrors } from "./luau-expect-error.ts";
import type { TypeTestDiagnostic } from "./types.ts";

const FILE = "a.spec-d.luau";

function apply({
	diagnostics,
	source,
}: {
	diagnostics: Array<TypeTestDiagnostic>;
	filePath: string;
	source: string;
}): Array<TypeTestDiagnostic> {
	const parsed = luauParser.parse(source);
	assert(parsed.ok);
	return applyLuauExpectErrors({ diagnostics, filePath: FILE, parsed, source });
}

function diagnostic(line: number, column = 1): TypeTestDiagnostic {
	return { code: "TypeError", column, filePath: FILE, line, message: `at ${String(line)}` };
}

function unused(line: number, column = 1): TypeTestDiagnostic {
	return {
		code: "ExpectError",
		column,
		filePath: FILE,
		line,
		message: "unused @expect-error",
	};
}

describe(applyLuauExpectErrors, () => {
	it("should consume a diagnostic on the statement after the directive", () => {
		expect.assertions(1);

		const source = ["--!strict", "-- @expect-error", 'local _x: number = "a"'].join("\n");

		expect(apply({ diagnostics: [diagnostic(3)], filePath: FILE, source })).toStrictEqual([]);
	});

	it("should report a directive that consumes nothing at its own position", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			'it("x", function()',
			"\t-- @expect-error",
			"\tlocal _x: number = 1",
			"end)",
		].join("\n");

		expect(apply({ diagnostics: [], filePath: FILE, source })).toStrictEqual([unused(3, 2)]);
	});

	it("should not let a trailing directive cross into the next block", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			'it("a", function()',
			"\tlocal _ok: number = 1",
			"\t-- @expect-error",
			"end)",
			'it("b", function()',
			'\tlocal _bad: number = "x"',
			"end)",
		].join("\n");

		expect(apply({ diagnostics: [diagnostic(7, 2)], filePath: FILE, source })).toStrictEqual([
			diagnostic(7, 2),
			unused(4, 2),
		]);
	});

	it("should report a directive after the last statement of the file", () => {
		expect.assertions(1);

		const source = ["--!strict", "local _x: number = 1", "-- @expect-error"].join("\n");

		expect(apply({ diagnostics: [], filePath: FILE, source })).toStrictEqual([unused(3)]);
	});

	it("should consume a diagnostic inside a multi-line target", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			"type P = { x: number, y: number }",
			"-- @expect-error",
			"local _p: P = {",
			"\tx = 1,",
			'\ty = "a",',
			"}",
		].join("\n");

		expect(apply({ diagnostics: [diagnostic(6, 2)], filePath: FILE, source })).toStrictEqual(
			[],
		);
	});

	it("should consume every diagnostic under one directive", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			"-- @expect-error",
			'local _x: number, _y: number = "a", "b"',
		].join("\n");

		expect(
			apply({
				diagnostics: [diagnostic(3, 1), diagnostic(3, 20)],
				filePath: FILE,
				source,
			}),
		).toStrictEqual([]);
	});

	it("should report an unused directive at file level", () => {
		expect.assertions(1);

		const source = ["--!strict", "-- @expect-error", "local _x = 1"].join("\n");

		expect(apply({ diagnostics: [], filePath: FILE, source })).toStrictEqual([unused(2)]);
	});

	it("should keep a diagnostic with no directive", () => {
		expect.assertions(1);

		const source = ["--!strict", "local _x = 1", 'local _y: number = "a"'].join("\n");

		expect(apply({ diagnostics: [diagnostic(3)], filePath: FILE, source })).toStrictEqual([
			diagnostic(3),
		]);
	});

	it("should ignore @expect-error inside a string", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			'local _s = "-- @expect-error"',
			'local _x: number = "a"',
		].join("\n");

		expect(apply({ diagnostics: [diagnostic(3)], filePath: FILE, source })).toStrictEqual([
			diagnostic(3),
		]);
	});

	it("should keep diagnostics outside the target and report a directive with no statement", () => {
		expect.assertions(1);

		const source = ["--!strict", 'local _x: number = "a"', "-- @expect-error"].join("\n");

		expect(apply({ diagnostics: [diagnostic(2)], filePath: FILE, source })).toStrictEqual([
			diagnostic(2),
			unused(3),
		]);
	});
});
