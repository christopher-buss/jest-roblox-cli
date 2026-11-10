import { describe, expect, it } from "vitest";

import type { RunProgress } from "./run-progress.ts";
import { createStageAnnouncer } from "./stage-announcer.ts";

function createRecordingProgress(): { calls: Array<string>; progress: RunProgress } {
	const calls: Array<string> = [];
	const progress: RunProgress = {
		begin: (id) => {
			calls.push(`begin:${id}`);
			return () => {
				calls.push(`end:${id}`);
			};
		},
		describe: () => {},
		finish: () => {},
		interleave: (write) => {
			write();
		},
		note: () => {},
		reveal: () => {},
	};

	return { calls, progress };
}

describe(createStageAnnouncer, () => {
	it("should open and close the stage a span stands for", () => {
		expect.assertions(1);

		const { calls, progress } = createRecordingProgress();
		const announcer = createStageAnnouncer(progress);

		announcer.open("prepareCoverage");
		announcer.close("prepareCoverage");
		announcer.open("rojoBuild");
		announcer.close("rojoBuild");

		expect(calls).toStrictEqual([
			"begin:instrument",
			"end:instrument",
			"begin:build",
			"end:build",
		]);
	});

	it("should stay silent for a span that stands for no stage", () => {
		expect.assertions(1);

		const { calls, progress } = createRecordingProgress();
		const announcer = createStageAnnouncer(progress);

		announcer.open("buildJobs");
		announcer.close("buildJobs");

		expect(calls).toStrictEqual([]);
	});

	it("should close nothing for a stage span that never opened", () => {
		expect.assertions(1);

		const { calls, progress } = createRecordingProgress();

		createStageAnnouncer(progress).close("rojoBuild");

		expect(calls).toStrictEqual([]);
	});
});
