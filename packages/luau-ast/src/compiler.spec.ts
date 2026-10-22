import { describe, expect, it } from "vitest";

import type { CompilerWasmRuntime } from "./compiler-wasm-runtime.ts";
import { loadLuauCompiler } from "./compiler.ts";
import type { LuauCompileFailure, LuauCompileSuccess } from "./compiler.ts";

describe(loadLuauCompiler, () => {
	it("should omit the bytecode listing by default", () => {
		expect.assertions(2);

		const requests: Array<Parameters<CompilerWasmRuntime["compileWithStatistics"]>[0]> = [];
		const compiler = loadLuauCompiler({
			compileWithStatistics: (request) => {
				requests.push(request);
				return '{"ok":true,"frames":[]}';
			},
		});
		const result = compiler.compile("return 1", { debugLevel: 2, optimizationLevel: 1 });

		expect(requests).toStrictEqual([
			{ bytecodeText: false, debugLevel: 2, optimizationLevel: 1, source: "return 1" },
		]);
		expect(result).toStrictEqual({ frames: [], ok: true });
	});
});

describe("decode of a malformed compiler payload", () => {
	it.for([
		"[]",
		'{"ok":true}',
		'{"ok":true,"frames":[{}]}',
		'{"ok":false}',
		'{"ok":false,"error":{}}',
	])("should fail loudly on malformed output %s", (payload) => {
		expect.assertions(1);

		const compiler = loadLuauCompiler({ compileWithStatistics: ({ source }) => source });

		expect(() => {
			compiler.compile(payload, { debugLevel: 2, optimizationLevel: 1 });
		}).toThrow("compiler wasm returned an unrecognized JSON shape");
	});

	it("should reject a successful-looking diagnostic with an invalid discriminator", () => {
		expect.assertions(1);

		const payload = {
			error: { location: compilerPayload().frames[0]!.location, message: "bad" },
			ok: "invalid",
		};

		expect(() => {
			return payloadCompiler(payload).compile("source", {
				debugLevel: 0,
				optimizationLevel: 0,
			});
		}).toThrow("unrecognized JSON shape");
	});
});

function payloadCompiler(payload: JSONValue) {
	return loadLuauCompiler({ compileWithStatistics: () => JSON.stringify(payload) });
}

function compilerPayload() {
	return {
		bytecodeText: "bytecode listing",
		frames: [
			{
				location: { beginColumn: 2, beginLine: 3, endColumn: 5, endLine: 7 },
				maxRegisters: 8,
				peakLocals: 6,
				upvalueCount: 4,
			},
		],
		ok: true,
	} satisfies LuauCompileSuccess;
}

describe("compiler payloads", () => {
	it("should decode every frame field and preserve the requested bytecode", () => {
		expect.assertions(1);

		const payload = compilerPayload();

		expect(
			payloadCompiler(payload).compile("source", {
				bytecodeText: true,
				debugLevel: 0,
				optimizationLevel: 2,
			}),
		).toStrictEqual(payload);
	});

	it.for([{}, { localName: "variable" }])("should decode failures with local name %s", (name) => {
		expect.assertions(1);

		const payload = {
			error: {
				...name,
				location: compilerPayload().frames[0]!.location,
				message: "register limit",
			},
			ok: false,
		} satisfies LuauCompileFailure;

		expect(
			payloadCompiler(payload).compile("invalid", { debugLevel: 1, optimizationLevel: 0 }),
		).toStrictEqual(payload);
	});

	it.for(["beginColumn", "beginLine", "endColumn", "endLine"])(
		"should reject a nonnumeric %s coordinate",
		(key) => {
			expect.assertions(1);

			const payload = compilerPayload();
			Object.assign(payload.frames[0]!.location, { [key]: "bad" });

			expect(() => {
				return payloadCompiler(payload).compile("source", {
					debugLevel: 0,
					optimizationLevel: 0,
				});
			}).toThrow("unrecognized JSON shape");
		},
	);

	it.for(["maxRegisters", "peakLocals", "upvalueCount"])(
		"should reject a nonnumeric %s statistic",
		(key) => {
			expect.assertions(1);

			const payload = compilerPayload();
			Object.assign(payload.frames[0]!, { [key]: null });

			expect(() => {
				return payloadCompiler(payload).compile("source", {
					debugLevel: 0,
					optimizationLevel: 0,
				});
			}).toThrow("unrecognized JSON shape");
		},
	);

	it.for([
		null,
		0,
		{},
		{ ok: "yes" },
		{ frames: "frames", ok: true },
		{ frames: [null], ok: true },
		{ bytecodeText: 1, frames: [], ok: true },
		{ error: { location: null, message: "bad" }, ok: false },
		{ error: { location: [], message: "bad" }, ok: false },
		{ error: { location: compilerPayload().frames[0]!.location, message: 1 }, ok: false },
		{
			error: {
				localName: 1,
				location: compilerPayload().frames[0]!.location,
				message: "bad",
			},
			ok: false,
		},
	])("should reject malformed payload %#", (payload) => {
		expect.assertions(1);

		expect(() => {
			return payloadCompiler(payload).compile("source", {
				debugLevel: 0,
				optimizationLevel: 0,
			});
		}).toThrow("unrecognized JSON shape");
	});

	it("should cache the default compiler separately from injected instances", () => {
		expect.assertions(2);

		expect(loadLuauCompiler()).toBe(loadLuauCompiler());
		expect(loadLuauCompiler()).not.toBe(payloadCompiler(compilerPayload()));
	});
});
