import { assert, describe, expect, it } from "vitest";

import type { LuauCompileOptions } from "./compiler.ts";
import { loadLuauCompiler } from "./compiler.ts";

function constantLocals(localCount: number): Array<string> {
	return Array.from(
		{ length: localCount },
		(_unused, localIndex) => `local value${String(localIndex)} = ${String(localIndex)}`,
	);
}

describe("compile", () => {
	it("should report statistics for the main function frame", () => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		const result = compiler.compile("local value = input()\nreturn value", {
			debugLevel: 2,
			optimizationLevel: 1,
		});

		assert(result.ok);

		expect(result.frames).toStrictEqual([
			{
				location: {
					beginColumn: 1,
					beginLine: 1,
					endColumn: 13,
					endLine: 2,
				},
				maxRegisters: 1,
				peakLocals: 1,
				upvalueCount: 0,
			},
		]);
	});

	it("should report every nested function frame in compiler order", () => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		const source = [
			"local captured = input()",
			"local closure = function(argument)",
			"\treturn captured",
			"end",
			"return closure",
		].join("\n");
		const result = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });

		assert(result.ok);

		expect(result.frames).toStrictEqual([
			{
				location: { beginColumn: 17, beginLine: 2, endColumn: 4, endLine: 4 },
				maxRegisters: 2,
				peakLocals: 1,
				upvalueCount: 1,
			},
			{
				location: { beginColumn: 1, beginLine: 1, endColumn: 15, endLine: 5 },
				maxRegisters: 2,
				peakLocals: 2,
				upvalueCount: 0,
			},
		]);
	});

	it("should stack nested-block locals and reuse sibling-block slots", () => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		const source = [
			...constantLocals(100),
			"do",
			...constantLocals(60),
			"end",
			"do",
			...constantLocals(70),
			"end",
		].join("\n");
		const result = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });

		assert(result.ok);

		expect(result.frames.at(-1)!.peakLocals).toBe(170);
	});

	it("should count a loop variable toward the 200-local limit", () => {
		expect.assertions(2);

		const compiler = loadLuauCompiler();

		const options = { debugLevel: 2, optimizationLevel: 1 } satisfies LuauCompileOptions;
		const fitting = compiler.compile(
			[...constantLocals(199), "for index = 1, 1 do", "\tprint(index)", "end"].join("\n"),
			options,
		);
		const overflowing = compiler.compile(
			[...constantLocals(200), "for index = 1, 1 do", "\tprint(index)", "end"].join("\n"),
			options,
		);

		assert(fitting.ok);
		assert(!overflowing.ok);

		expect(fitting.frames.at(-1)!.peakLocals).toBe(200);
		expect(overflowing.error.localName).toBe("index");
	});

	it("should retain constants at debug level 2 and elide them at debug level 1", () => {
		expect.assertions(2);

		const compiler = loadLuauCompiler();

		const source = constantLocals(201).join("\n");
		const debugTwo = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });
		const debugOne = compiler.compile(source, { debugLevel: 1, optimizationLevel: 1 });

		assert(!debugTwo.ok);
		assert(debugOne.ok);

		expect(debugTwo.error.localName).toBe("value200");
		expect(debugOne.frames.at(-1)!.peakLocals).toBe(0);
	});

	it("should compile 200 locals with 54 call arguments and reject 55", () => {
		expect.assertions(3);

		const compiler = loadLuauCompiler();

		const localDeclarations = constantLocals(200);
		const argumentNames = Array.from(
			{ length: 55 },
			(_unused, argumentIndex) => `value${String(argumentIndex)}`,
		);
		const options = { debugLevel: 2, optimizationLevel: 1 } satisfies LuauCompileOptions;
		const fitting = compiler.compile(
			[...localDeclarations, `call(${argumentNames.slice(0, 54).join(", ")})`].join("\n"),
			options,
		);
		const overflowing = compiler.compile(
			[...localDeclarations, `call(${argumentNames.join(", ")})`].join("\n"),
			options,
		);

		assert(fitting.ok);
		assert(!overflowing.ok);

		expect(fitting.frames.at(-1)!.maxRegisters).toBe(255);
		expect(overflowing.error.message).toBe(
			"Out of registers when trying to allocate 56 registers: exceeded limit 255",
		);
		expect(overflowing.error.localName).toBeUndefined();
	});

	it("should reject one closure that captures 201 upvalues", () => {
		expect.assertions(2);

		const compiler = loadLuauCompiler();

		const innerLocals = Array.from(
			{ length: 51 },
			(_unused, localIndex) => `\tlocal inner${String(localIndex)} = input()`,
		);
		const captures = [
			...Array.from(
				{ length: 150 },
				(_unused, captureIndex) => `value${String(captureIndex)}`,
			),
			...Array.from(
				{ length: 51 },
				(_unused, captureIndex) => `inner${String(captureIndex)}`,
			),
		];
		const source = [
			...constantLocals(150),
			"local function outer()",
			...innerLocals,
			"\treturn function()",
			`\t\treturn { ${captures.join(", ")} }`,
			"\tend",
			"end",
		].join("\n");
		const result = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });

		assert(!result.ok);

		expect(result.error.message).toBe(
			"Out of upvalue registers when trying to allocate value149: exceeded limit 200",
		);
		expect(result.error.localName).toBe("value149");
	});

	it("should preserve a compile error's message, location, and local name", () => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		const source = [...constantLocals(200), "local overflowing = input()"].join("\n");
		const result = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });

		assert(!result.ok);

		expect(result.error).toStrictEqual({
			localName: "overflowing",
			location: {
				beginColumn: 7,
				beginLine: 201,
				endColumn: 18,
				endLine: 201,
			},
			message:
				"Out of local registers when trying to allocate overflowing: exceeded limit 200",
		});
	});

	it("should report the local named by a repeat-until continue error", () => {
		expect.assertions(2);

		const compiler = loadLuauCompiler();

		const source = [
			"repeat",
			"\tif input() then continue end",
			"\tlocal value = input()",
			"until value",
		].join("\n");
		const result = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });

		assert(!result.ok);

		expect(result.error.message).toBe(
			"Local value used in the repeat..until condition is undefined because continue statement on line 2 jumps over it",
		);
		expect(result.error.localName).toBe("value");
	});

	it("should compile source that outgrows the initial wasm heap", () => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		const source = `--[[${"x".repeat(17 * 1024 * 1024)}]]`;
		const result = compiler.compile(source, { debugLevel: 2, optimizationLevel: 1 });

		assert(result.ok);

		expect(result.frames).toHaveLength(1);
	});

	it("should return the same compiler instance on repeat loads", () => {
		expect.assertions(1);

		const compiler = loadLuauCompiler();

		expect(loadLuauCompiler()).toBe(compiler);
	});
});
