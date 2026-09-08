import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { CstParseResult } from "./cst-materialize.ts";
import { loadLuauParser } from "./parser.ts";
import { DEFECT_MARKER } from "./wasm-runtime.ts";

// Fakes the wasm runtime so materialization can be fed trees the real
// serializer never produces: a token skipped, tokens overlapping, a defect
// message, an unrecognized shape. Each test registers the payload the fake
// answers for its source.
const payloads = vi.hoisted(() => new Map<string, string>());

vi.mock(import("./wasm-runtime.ts"), async (importOriginal) => {
	return {
		...(await importOriginal()),
		createWasmRuntime: () => {
			return {
				injectCstFault: () => {},
				parseToCstJson: (source: string) => payloads.get(source) ?? source,
				parseToJson: (source: string) => source,
			};
		},
	};
});

const SOURCE = "local x = 1";

interface TreeOverrides {
	name?: string;
	keyword?: string;
}

/** Register the payload the fake answers for `source`, for this test only. */
function parseWithPayload(fileName: string, payload: string, source = SOURCE): CstParseResult {
	payloads.set(source, payload);
	onTestFinished(() => {
		payloads.delete(source);
	});

	return loadLuauParser().parseCst({ fileName, source });
}

/** The tree for `local x = 1`, with chosen token positions substituted. */
function localStatement(overrides: TreeOverrides): string {
	const keyword = overrides.keyword ?? "[0,0,0,5]";
	const name = overrides.name ?? "[0,6,0,7]";
	return `{"type":"Root","location":[0,0,0,11],"body":{"type":"Block","location":[0,0,0,11],"body":[{"type":"Local","location":[0,0,0,11],"keyword":${keyword},"variables":[{"node":{"type":"LocalDecl","location":[0,6,0,7],"binding":1,"name":${name}}}],"equals":[0,8,0,9],"values":[{"node":{"type":"Number","location":[0,10,0,11],"token":[0,10,0,11]}}]}]}}`;
}

describe("gap detector", () => {
	it("should name the file, the two tokens, and the bytes when a token is skipped", () => {
		expect.assertions(1);

		// The name token points at the `=`, so `x` falls into the gap between
		// `local` and `=` with whitespace on both sides.
		const result = parseWithPayload("skipped.luau", localStatement({ name: "[0,8,0,9]" }));

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'skipped.luau: bytes "x" between token "local" at 1:1 and token "=" at 1:9 are not whitespace or a comment',
		]);
	});

	it("should name the start of the file when bytes precede the first token", () => {
		expect.assertions(1);

		const result = parseWithPayload("first.luau", localStatement({ keyword: "[0,2,0,5]" }));

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'first.luau: bytes "lo" between the start of the file and token "cal" at 1:3 are not whitespace or a comment',
		]);
	});

	it("should treat an unterminated block comment as offending bytes", () => {
		expect.assertions(1);

		const source = `${SOURCE} --[[ open`;
		const result = parseWithPayload("open.luau", localStatement({}), source);

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'open.luau: bytes "--[[ open" between token "1" at 1:11 and token "" at 1:22 are not whitespace or a comment',
		]);
	});

	it("should report a token that overlaps the previous one", () => {
		expect.assertions(1);

		const result = parseWithPayload("overlap.luau", localStatement({ name: "[0,4,0,7]" }));

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'overlap.luau: token "l x" at 1:5 overlaps token "local" at 1:1',
		]);
	});
});

describe("decode of a malformed CST payload", () => {
	it("should surface a serializer defect as an error result", () => {
		expect.assertions(1);

		const result = parseWithPayload(
			"defect.luau",
			`${DEFECT_MARKER}cst writer: close without a matching open`,
		);

		expect(result).toStrictEqual({
			errors: ["defect.luau: cst writer: close without a matching open"],
			ok: false,
		});
	});

	it("should fail loudly when the JSON is not a tree", () => {
		expect.assertions(1);

		expect(() => parseWithPayload("shape.luau", '{"type":"Nope"}')).toThrow(
			"wasm wrapper returned an unrecognized CST shape",
		);
	});
});
