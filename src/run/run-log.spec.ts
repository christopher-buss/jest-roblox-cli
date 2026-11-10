import { Buffer } from "node:buffer";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { FormatterEntry } from "../config/formatter-selection.ts";
import type { RunLogOptions } from "./run-log.ts";
import { withRunLogAsync } from "./run-log.ts";

type RunLogStreams = RunLogOptions<unknown>["streams"];
type RunLogStream = RunLogStreams["stdout"];

function runLogPath(rootDirectory: string): string {
	return path.join(rootDirectory, ".jest-roblox", "last-run.log");
}

const ROOT = "/project";
const RUN_ROOT = "/workspace";

interface FakeStream extends RunLogStream {
	readonly received: Array<string>;
}

function makeStream(): FakeStream {
	const received: Array<string> = [];
	return {
		received,
		write: (chunk) => {
			received.push(String(chunk));
			return true;
		},
	};
}

function makeStreams(): RunLogStreams & { stderr: FakeStream; stdout: FakeStream } {
	return { stderr: makeStream(), stdout: makeStream() };
}

function makeHarness(formatters: Array<FormatterEntry> = ["default"]) {
	const { fileSystem, volume } = createMemoryFileSystem({}, ROOT);
	const streams = makeStreams();
	const options = {
		config: { formatters, rootDir: ROOT, verbose: false },
		fileSystem,
		runTarget: (): ReturnType<RunLogOptions<unknown>["runTarget"]> => undefined,
		streams,
	};
	function readLog(): string {
		return String(volume.readFileSync(runLogPath(ROOT), "utf8"));
	}

	return { fileSystem, options, readLog, streams, volume };
}

describe(withRunLogAsync, () => {
	it("should write both streams to the log in the order they were written", async () => {
		expect.assertions(1);

		const { options, readLog, streams } = makeHarness();
		await withRunLogAsync(options, async () => {
			streams.stdout.write("summary\n");
			streams.stderr.write("warning\n");
			streams.stdout.write("footer\n");
			return 0;
		});

		expect(readLog()).toBe("summary\nwarning\nfooter\n");
	});

	it("should close the log when the run ends", async () => {
		expect.assertions(1);

		const { options } = makeHarness();
		const closeSync = vi.spyOn(options.fileSystem, "closeSync");
		await withRunLogAsync(options, async () => 0);

		expect(closeSync).toHaveBeenCalledOnce();
	});

	it("should log bytes as well as strings", async () => {
		expect.assertions(1);

		const { options, readLog, streams } = makeHarness();
		await withRunLogAsync(options, async () => {
			streams.stdout.write(Buffer.from("bytes\n"));
			return 0;
		});

		expect(readLog()).toBe("bytes\n");
	});

	it("should still write through to the streams", async () => {
		expect.assertions(2);

		const { options, streams } = makeHarness();
		await withRunLogAsync(options, async () => {
			streams.stdout.write("summary\n");
			streams.stderr.write("warning\n");
			return 0;
		});

		expect(streams.stdout.received).toStrictEqual(["summary\n"]);
		expect(streams.stderr.received).toStrictEqual(["warning\n"]);
	});

	it("should return what the run returned", async () => {
		expect.assertions(1);

		const { options } = makeHarness();

		await expect(withRunLogAsync(options, async () => 1)).resolves.toBe(1);
	});

	it("should stop recording once the run ends", async () => {
		expect.assertions(1);

		const { options, readLog, streams } = makeHarness();
		await withRunLogAsync(options, async () => {
			streams.stdout.write("inside\n");
			return 0;
		});
		streams.stdout.write("after\n");

		expect(readLog()).toBe("inside\n");
	});

	it("should stop recording and rethrow when the run throws", async () => {
		expect.assertions(2);

		const { options, readLog, streams } = makeHarness();
		const failure = new Error("boom");

		await expect(
			withRunLogAsync(options, async () => {
				streams.stderr.write("dying\n");
				throw failure;
			}),
		).rejects.toBe(failure);

		streams.stderr.write("after\n");

		expect(readLog()).toBe("dying\n");
	});

	it("should overwrite the previous run's log", async () => {
		expect.assertions(1);

		const { options, readLog, streams } = makeHarness();
		await withRunLogAsync(options, async () => {
			streams.stdout.write("first\n");
			return 0;
		});
		await withRunLogAsync(options, async () => {
			streams.stdout.write("second\n");
			return 0;
		});

		expect(readLog()).toBe("second\n");
	});

	it("should point the agent formatter at the log after the run", async () => {
		expect.assertions(1);

		const { options, streams } = makeHarness(["agent"]);
		await withRunLogAsync(options, async () => {
			streams.stdout.write("summary\n");
			return 0;
		});

		expect(streams.stderr.received.at(-1)).toContain(runLogPath(ROOT));
	});

	it("should keep the hint out of the log", async () => {
		expect.assertions(1);

		const { options, readLog, streams } = makeHarness(["agent"]);
		await withRunLogAsync(options, async () => {
			streams.stdout.write("summary\n");
			return 0;
		});

		expect(readLog()).toBe("summary\n");
	});

	it("should say nothing to a human formatter", async () => {
		expect.assertions(1);

		const { options, streams } = makeHarness(["default"]);
		await withRunLogAsync(options, async () => 0);

		expect(streams.stderr.received).toStrictEqual([]);
	});

	it("should run without a log when the log cannot be opened", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({ "/project/.jest-roblox": "a file" }, ROOT);
		const streams = makeStreams();
		const options = {
			config: {
				formatters: ["agent"] as Array<FormatterEntry>,
				rootDir: ROOT,
				verbose: false,
			},
			fileSystem,
			runTarget: (): ReturnType<RunLogOptions<unknown>["runTarget"]> => undefined,
			streams,
		};

		await expect(
			withRunLogAsync(options, async () => {
				streams.stdout.write("summary\n");
				return 0;
			}),
		).resolves.toBe(0);

		expect(streams.stderr.received).toStrictEqual([]);
	});
});

describe("withRunLogAsync with a run target", () => {
	it("should move the log under the run's root and name it for the run's agent formatter", async () => {
		expect.assertions(3);

		const { options, streams, volume } = makeHarness(["default"]);
		await withRunLogAsync(
			{
				...options,
				runTarget: () => {
					return {
						formatters: ["agent"] as Array<FormatterEntry>,
						rootDir: RUN_ROOT,
						verbose: false,
					};
				},
			},
			async () => {
				streams.stdout.write("summary\n");
				return 0;
			},
		);

		expect(String(volume.readFileSync(runLogPath(RUN_ROOT), "utf8"))).toBe("summary\n");
		expect(volume.existsSync(runLogPath(ROOT))).toBeFalse();
		expect(streams.stderr.received).toStrictEqual([
			`jest-roblox: the full output of this run is at ${runLogPath(RUN_ROOT)}\n`,
		]);
	});

	it.for<{ formatters: Array<FormatterEntry>; verbose: boolean }>([
		{ formatters: ["default"], verbose: false },
		{ formatters: ["agent"], verbose: true },
	])("should not name the log when the run does not render for an agent (%o)", async (target) => {
		expect.assertions(1);

		const { options, streams } = makeHarness(["agent"]);
		await withRunLogAsync(
			{ ...options, runTarget: () => ({ ...target, rootDir: ROOT }) },
			async () => 0,
		);

		expect(streams.stderr.received).toStrictEqual([]);
	});

	it("should keep the log where it was written when it cannot move", async () => {
		expect.assertions(2);

		const { fileSystem, options, streams, volume } = makeHarness(["default"]);
		vi.spyOn(fileSystem, "renameSync").mockImplementation(() => {
			throw new Error("EXDEV");
		});
		await withRunLogAsync(
			{
				...options,
				runTarget: () => {
					return {
						formatters: ["agent"] as Array<FormatterEntry>,
						rootDir: RUN_ROOT,
						verbose: false,
					};
				},
			},
			async () => 0,
		);

		expect(volume.existsSync(runLogPath(ROOT))).toBeTrue();
		expect(streams.stderr.received).toStrictEqual([
			`jest-roblox: the full output of this run is at ${runLogPath(ROOT)}\n`,
		]);
	});
});
