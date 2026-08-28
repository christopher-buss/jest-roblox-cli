import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
	createRunProgress,
	createStdoutRunProgress,
	NOOP_RUN_PROGRESS,
	type RunProgressOptions,
} from "./reporter.ts";

const ESC = String.fromCharCode(27);
const ERASE_ONE_ROW = `${ESC}[1A${ESC}[0J`;
const FOREIGN_LINE = "▶ @halcyon/inventory  12 passed";

function createHarness(overrides: Partial<RunProgressOptions> = {}) {
	const writes: Array<string> = [];
	let clock = 0;
	const progress = createRunProgress({
		frameMs: 1_000_000,
		guarded: [],
		live: false,
		now: () => clock,
		sink: (text) => {
			writes.push(text);
		},
		width: 80,
		...overrides,
	});

	return {
		advance: (ms: number) => {
			clock += ms;
		},
		progress,
		writeForeignLine: () => {
			progress.interleave(() => {
				writes.push(`${FOREIGN_LINE}\n`);
			});
		},
		writes,
	};
}

/** Presents both standard streams as a terminal for the length of one test. */
function pretendTerminal(): void {
	for (const stream of [process.stdout, process.stderr]) {
		const wasTTY = stream.isTTY;
		Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		onTestFinished(() => {
			Object.defineProperty(stream, "isTTY", { configurable: true, value: wasTTY });
		});
	}
}

describe(createRunProgress, () => {
	it("should write nothing until the run header has been shown", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.begin("upload", "12.4 MB")();

		expect(writes).toStrictEqual([]);
	});

	it("should replay stages that already finished once the header is shown", () => {
		expect.assertions(1);

		const { advance, progress, writes } = createHarness();
		const done = progress.begin("instrument");
		advance(8400);
		done("318 files");
		progress.reveal({ color: false });

		expect(writes).toStrictEqual([" ✓ instrument       318 files  8.4s\n"]);
	});

	it("should replay finished stages only once however often the header lands", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.begin("instrument")();
		progress.reveal({ color: false });
		progress.reveal({ color: false });

		expect(writes).toHaveLength(1);
	});

	it("should announce a stage as it opens and again as it closes", () => {
		expect.assertions(1);

		const { advance, progress, writes } = createHarness();
		progress.reveal({ color: false });
		const done = progress.begin("upload", "12.4 MB");
		advance(4700);
		done("version 88");

		expect(writes).toStrictEqual([
			" → upload           12.4 MB\n",
			" ✓ upload           version 88  4.7s\n",
		]);
	});

	it("should keep the first closing detail when a closer is called twice", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.reveal({ color: false });
		const done = progress.begin("upload");
		done("version 88");
		done("version 99");

		expect(writes).toStrictEqual([" → upload\n", " ✓ upload           version 88  0ms\n"]);
	});

	it("should carry a detail the work itself produced onto the closing line", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.reveal({ color: false });
		const done = progress.begin("build");
		progress.describe("build", "12.4 MB");
		done();

		// The whole run of writes: a detail must reach the closing line without
		// printing a line of its own in the append-only shape.
		expect(writes).toStrictEqual([" → build place\n", " ✓ build place      12.4 MB  0ms\n"]);
	});

	it("should ignore a detail for a stage that never opened", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.reveal({ color: false });
		progress.describe("build", "12.4 MB");

		expect(writes).toStrictEqual([]);
	});

	it("should report a stage that was over before it started as one line", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.reveal({ color: false });
		progress.note("upload", "cache hit, version 87");

		expect(writes).toStrictEqual([" ✓ upload           cache hit, version 87  0ms\n"]);
	});

	it("should name the stage a run died inside", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.reveal({ color: false });
		progress.begin("boot", "version 88");
		progress.finish();

		expect(writes.at(-1)).toBe(" · boot probe       version 88\n");
	});

	it("should keep a stage silent when the run never showed a header", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.begin("boot")();
		progress.finish();

		expect(writes).toStrictEqual([]);
	});

	it("should let a foreign line straight through when no block is drawn", () => {
		expect.assertions(1);

		const { writeForeignLine, writes } = createHarness();
		writeForeignLine();

		expect(writes).toStrictEqual([`${FOREIGN_LINE}\n`]);
	});

	it("should leave the scrollback alone in the append-only shape", () => {
		expect.assertions(1);

		const { progress, writeForeignLine, writes } = createHarness();
		progress.begin("instrument")();
		progress.reveal({ color: false });
		writeForeignLine();

		// No cursor movement anywhere: a replayed line is already scrollback,
		// and erasing it would take a line of someone else's output with it.
		expect(writes.join("")).not.toContain(ESC);
	});

	it("should shorten a detail that would wrap the terminal", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness({ width: 40 });
		progress.reveal({ color: false });
		progress.begin("upload", "a-very-long-place-name-that-keeps-going.rbxl");

		expect(writes).toStrictEqual([" → upload           a-very-lo…\n"]);
	});

	it("should accumulate the time of a stage that runs more than once", () => {
		expect.assertions(1);

		const { advance, progress, writes } = createHarness();
		progress.reveal({ color: false });
		const first = progress.begin("instrument", "3 packages");
		advance(1200);
		first();
		const second = progress.begin("instrument");
		advance(800);
		second();

		expect(writes.at(-1)).toBe(" ✓ instrument       3 packages  2.0s\n");
	});

	it("should say nothing anywhere through the shared silent reporter", () => {
		expect.assertions(1);

		const written: Array<string> = [];
		NOOP_RUN_PROGRESS.reveal({ color: false });
		NOOP_RUN_PROGRESS.begin("upload", "12.4 MB")("version 88");
		NOOP_RUN_PROGRESS.describe("upload", "ignored");
		NOOP_RUN_PROGRESS.note("upload", "ignored");
		NOOP_RUN_PROGRESS.finish();
		NOOP_RUN_PROGRESS.interleave(() => {
			written.push(FOREIGN_LINE);
		});

		expect(written).toStrictEqual([FOREIGN_LINE]);
	});

	it("should keep a detail that exactly fills the terminal", () => {
		expect.assertions(2);

		const { progress, writes } = createHarness({ width: 40 });
		progress.reveal({ color: false });
		// The clamp keeps a row inside the terminal, so the widest detail that
		// still fits must survive untouched while one character more must not.
		progress.begin("upload", "0123456789");
		progress.begin("boot", "01234567890");

		expect(writes[0]).toBe(" → upload           0123456789\n");
		expect(writes[1]).toBe(" → boot probe       012345678…\n");
	});

	it("should settle a stage the run finished before it ended", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness();
		progress.reveal({ color: false });
		progress.begin("upload")();
		const settled = writes.length;
		progress.finish();

		// Nothing was still open, so the end of the run has nothing to add.
		expect(writes).toHaveLength(settled);
	});

	it("should count the time a stage ran, not the clock it ran at", () => {
		expect.assertions(1);

		const { advance, progress, writes } = createHarness();
		advance(50_000);
		progress.reveal({ color: false });
		const done = progress.begin("upload");
		advance(1200);
		done();

		expect(writes.at(-1)).toBe(" ✓ upload           1.2s\n");
	});

	it("should hold the block back until the header, however the run ends", () => {
		expect.assertions(1);

		const { progress, writes } = createHarness({ live: true });
		progress.begin("upload", "12.4 MB");
		progress.finish();

		expect(writes).toStrictEqual([]);
	});

	describe("repainting block", () => {
		it("should stop animating once the run has ended", () => {
			expect.assertions(1);

			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const { progress, writes } = createHarness({ frameMs: 80, live: true });
			progress.reveal({ color: false });
			progress.begin("boot", "version 88");
			progress.finish();
			const settled = writes.length;
			vi.advanceTimersByTime(800);

			expect(writes).toHaveLength(settled);
		});

		it("should show a running stage the time it has been running", () => {
			expect.assertions(1);

			const { advance, progress, writes } = createHarness({ live: true });
			progress.reveal({ color: false });
			progress.begin("tests", "42 projects");
			advance(24_600);
			progress.describe("tests", "42 projects");

			expect(writes.at(-1)).toBe(`${ERASE_ONE_ROW} ⠋ run tests        42 projects  24.6s\n`);
		});

		it("should let go of its timer when the run ends", () => {
			expect.assertions(2);

			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const { progress } = createHarness({ frameMs: 80, live: true });
			progress.reveal({ color: false });
			progress.begin("boot", "version 88");

			expect(vi.getTimerCount()).toBe(1);

			progress.finish();

			// Nothing pending: a run that ended must not keep the process awake
			// or repaint over whatever prints next.
			expect(vi.getTimerCount()).toBe(0);
		});

		it("should draw the stages a run already had when the header lands", () => {
			expect.assertions(1);

			const { progress, writes } = createHarness({ live: true });
			progress.begin("instrument")();
			progress.reveal({ color: false });

			expect(writes).toStrictEqual([" ✓ instrument       0ms\n"]);
		});

		it("should keep animating while one stage of several is open", () => {
			expect.assertions(1);

			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const { progress, writes } = createHarness({ frameMs: 80, live: true });
			progress.reveal({ color: false });
			progress.begin("instrument")();
			progress.begin("tests", "42 projects");
			const settled = writes.length;
			vi.advanceTimersByTime(80);

			// One stage of the two is still open, so the block still moves.
			expect(writes.length).toBeGreaterThan(settled);
		});

		it("should time a running stage from when it opened", () => {
			expect.assertions(1);

			const { advance, progress, writes } = createHarness({ live: true });
			progress.reveal({ color: false });
			advance(20_000);
			progress.begin("tests", "42 projects");
			advance(2000);
			progress.describe("tests", "42 projects");

			// 2s since the stage opened, not the 22s since the run did.
			expect(writes.at(-1)).toBe(`${ERASE_ONE_ROW} ⠋ run tests        42 projects  2.0s\n`);
		});

		it("should redraw every row in place as stages progress", () => {
			expect.assertions(1);

			const { advance, progress, writes } = createHarness({ live: true });
			progress.reveal({ color: false });
			const done = progress.begin("upload", "12.4 MB");
			advance(4700);
			done("version 88");
			progress.finish();

			expect(writes).toStrictEqual([
				" ⠋ upload           12.4 MB  0ms\n",
				`${ERASE_ONE_ROW} ✓ upload           version 88  4.7s\n`,
				`${ERASE_ONE_ROW} ✓ upload           version 88  4.7s\n`,
			]);
		});

		it("should erase only the rows already on screen when a stage joins", () => {
			expect.assertions(1);

			const { progress, writes } = createHarness({ live: true });
			progress.reveal({ color: false });
			progress.begin("instrument");
			progress.begin("build");

			// One row was drawn, so one row is erased — the row `build` adds is
			// not on screen yet, and counting it would eat the line above the
			// block.
			expect(writes.at(-1)).toBe(
				`${ERASE_ONE_ROW} ⠋ instrument       0ms\n ⠋ build place      0ms\n`,
			);
		});

		it("should clear the block around a foreign line and draw it again after", () => {
			expect.assertions(1);

			const { progress, writeForeignLine, writes } = createHarness({ live: true });
			progress.reveal({ color: false });
			progress.begin("tests", "42 projects");
			writeForeignLine();

			expect(writes).toStrictEqual([
				" ⠋ run tests        42 projects  0ms\n",
				ERASE_ONE_ROW,
				`${FOREIGN_LINE}\n`,
				" ⠋ run tests        42 projects  0ms\n",
			]);
		});

		it("should advance the spinner on its own while a stage is still open", () => {
			expect.assertions(1);

			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const { progress, writes } = createHarness({ frameMs: 80, live: true });
			progress.reveal({ color: false });
			progress.begin("boot", "version 88");
			vi.advanceTimersByTime(80);
			progress.finish();

			expect(writes.at(1)).toBe(`${ERASE_ONE_ROW} ⠙ boot probe       version 88  0ms\n`);
		});

		it("should redraw the block when a stage reports what it produced", () => {
			expect.assertions(1);

			const { progress, writes } = createHarness({ live: true });
			progress.reveal({ color: false });
			progress.begin("build");
			progress.describe("build", "12.4 MB");

			expect(writes.at(-1)).toBe(`${ERASE_ONE_ROW} ⠋ build place      12.4 MB  0ms\n`);
		});

		it("should hold the frame while no stage is open", () => {
			expect.assertions(1);

			vi.useFakeTimers();
			onTestFinished(() => {
				vi.useRealTimers();
			});
			const { progress, writes } = createHarness({ frameMs: 80, live: true });
			progress.reveal({ color: false });
			progress.begin("upload", "12.4 MB")("version 88");
			const settled = writes.length;
			vi.advanceTimersByTime(800);

			expect(writes).toHaveLength(settled);
		});

		it("should lift a guarded stream's write clear of the block", () => {
			expect.assertions(2);

			const written: Array<string> = [];
			const guarded = {
				write: (chunk: string) => {
					written.push(chunk);
					return true;
				},
			};
			const { progress, writes } = createHarness({
				guarded: [fromAny(guarded)],
				live: true,
			});
			progress.reveal({ color: false });
			progress.begin("tests", "42 projects");
			guarded.write("Warning: cached place version is gone\n");

			expect(writes.slice(1)).toStrictEqual([
				ERASE_ONE_ROW,
				" ⠋ run tests        42 projects  0ms\n",
			]);
			expect(written).toStrictEqual(["Warning: cached place version is gone\n"]);
		});

		it("should hand a guarded stream its own write back when the run ends", () => {
			expect.assertions(1);

			const guarded = { write: () => true };
			const ownWrite = guarded.write;
			const { progress } = createHarness({ guarded: [fromAny(guarded)], live: true });
			progress.reveal({ color: false });
			progress.finish();

			expect(guarded.write).toBe(ownWrite);
		});
	});
});

describe(createStdoutRunProgress, () => {
	it("should announce stages on stdout", () => {
		expect.assertions(1);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		onTestFinished(() => {
			stdout.mockRestore();
		});

		const progress = createStdoutRunProgress();
		progress.reveal({ color: false });
		progress.begin("upload", "12.4 MB");
		progress.finish();

		expect(stdout).toHaveBeenCalledWith(expect.stringContaining("upload"));
	});

	it("should guard stderr while it shares the terminal with the block", () => {
		expect.assertions(2);

		pretendTerminal();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		onTestFinished(() => {
			stdout.mockRestore();
		});
		const ownWrite = process.stderr.write;

		const progress = createStdoutRunProgress();
		progress.reveal({ color: false });
		progress.begin("upload", "12.4 MB");

		expect(process.stderr.write).not.toBe(ownWrite);

		progress.finish();

		expect(process.stderr.write).toBe(ownWrite);
	});
});
