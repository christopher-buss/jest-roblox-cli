import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import { describe, expect, it } from "vitest";

import { buildSourceMap } from "./source-map.ts";

// The encoder here is hand-rolled, and four specs assert against maps it
// builds. A bug in the VLQ arithmetic would not fail loudly in any of them —
// it would quietly move where a frame resolves to — so the round trip through
// a real consumer is what holds it honest.
describe(buildSourceMap, () => {
	it("should round-trip a segment through the encoder and the tracer", () => {
		expect.assertions(2);

		const map = buildSourceMap({
			file: "out.luau",
			segments: [
				{ generatedColumn: 0, generatedLine: 1, sourceColumn: 0, sourceLine: 1 },
				{ generatedColumn: 4, generatedLine: 2, sourceColumn: 2, sourceLine: 7 },
			],
			source: "../src/input.ts",
		});
		const traced = new TraceMap(map);

		expect(originalPositionFor(traced, { column: 0, line: 1 })).toMatchObject({
			line: 1,
			source: "../src/input.ts",
		});
		expect(originalPositionFor(traced, { column: 4, line: 2 })).toMatchObject({
			column: 2,
			line: 7,
		});
	});
});
