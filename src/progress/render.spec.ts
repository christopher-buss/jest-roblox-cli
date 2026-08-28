import { describe, expect, it } from "vitest";

import { createStyles } from "../formatters/styles.ts";
import { formatStage } from "./render.ts";

const PLAIN = createStyles(false);
/** The append-only shape: no spinner, so no frame. */
const AS_LINE = { frame: undefined, styles: PLAIN };
/** The repainting shape, mid-animation. */
const AS_ROW = { frame: "⠹", styles: PLAIN };

describe(formatStage, () => {
	it("should announce a stage that just started without a duration", () => {
		expect.assertions(1);

		const line = formatStage(
			{ id: "upload", detail: "12.4 MB", elapsedMs: 0, state: "active" },
			AS_LINE,
		);

		expect(line).toBe(" → upload           12.4 MB");
	});

	it("should report sub-second work in milliseconds", () => {
		expect.assertions(1);

		const line = formatStage(
			{ id: "upload", detail: undefined, elapsedMs: 340, state: "done" },
			AS_LINE,
		);

		expect(line).toBe(" ✓ upload           340ms");
	});

	it("should turn over to seconds at exactly one second", () => {
		expect.assertions(2);

		const under = formatStage(
			{ id: "upload", detail: undefined, elapsedMs: 999, state: "done" },
			AS_LINE,
		);
		const at = formatStage(
			{ id: "upload", detail: undefined, elapsedMs: 1000, state: "done" },
			AS_LINE,
		);

		expect(under).toBe(" ✓ upload           999ms");
		expect(at).toBe(" ✓ upload           1.0s");
	});

	it("should report longer work in seconds to one decimal", () => {
		expect.assertions(1);

		const line = formatStage(
			{ id: "tests", detail: undefined, elapsedMs: 31_640, state: "done" },
			AS_LINE,
		);

		expect(line).toBe(" ✓ run tests        31.6s");
	});

	it("should carry the closing detail and duration when a stage completes", () => {
		expect.assertions(1);

		const line = formatStage(
			{ id: "upload", detail: "cache hit, version 87", elapsedMs: 220, state: "done" },
			AS_LINE,
		);

		expect(line).toBe(" ✓ upload           cache hit, version 87  220ms");
	});

	it("should omit the detail column when a stage reports none", () => {
		expect.assertions(1);

		const line = formatStage(
			{ id: "instrument", detail: undefined, elapsedMs: 8400, state: "done" },
			AS_LINE,
		);

		expect(line).toBe(" ✓ instrument       8.4s");
	});

	it("should mark a stage that never finished", () => {
		expect.assertions(1);

		const line = formatStage(
			{ id: "boot", detail: undefined, elapsedMs: 0, state: "unfinished" },
			AS_LINE,
		);

		expect(line).toBe(" · boot probe");
	});

	it("should show the spinner frame and the running duration while a stage works", () => {
		expect.assertions(1);

		const row = formatStage(
			{ id: "upload", detail: "12.4 MB", elapsedMs: 4700, state: "active" },
			AS_ROW,
		);

		expect(row).toBe(" ⠹ upload           12.4 MB  4.7s");
	});

	it("should drop the duration for a stage the run never finished", () => {
		expect.assertions(1);

		const row = formatStage(
			{ id: "boot", detail: "version 87", elapsedMs: 19_200, state: "unfinished" },
			AS_ROW,
		);

		expect(row).toBe(" · boot probe       version 87");
	});
});
