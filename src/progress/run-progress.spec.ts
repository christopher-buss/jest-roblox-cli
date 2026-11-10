import { describe, expect, it } from "vitest";

import { NOOP_RUN_PROGRESS } from "./run-progress.ts";

describe("nOOP_RUN_PROGRESS", () => {
	it("should say nothing anywhere through the shared silent reporter", () => {
		expect.assertions(1);

		const written: Array<string> = [];
		NOOP_RUN_PROGRESS.reveal({ color: false });
		NOOP_RUN_PROGRESS.begin("upload", "12.4 MB")("version 88");
		NOOP_RUN_PROGRESS.describe("upload", "ignored");
		NOOP_RUN_PROGRESS.note("upload", "ignored");
		NOOP_RUN_PROGRESS.finish();
		NOOP_RUN_PROGRESS.interleave(() => {
			written.push("foreign\n");
		});

		expect(written).toStrictEqual(["foreign\n"]);
	});
});
