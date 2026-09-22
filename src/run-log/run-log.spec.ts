import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { RunLogStream, RunLogStreams } from "./run-log.ts";
import { runLogPath, withRunLogAsync } from "./run-log.ts";

const ROOT = "/project";

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

function makeHarness(formatters: Array<string> = ["default"]) {
	const { fileSystem, volume } = createMemoryFileSystem({}, ROOT);
	const streams = makeStreams();
	const options = { config: { formatters, rootDir: ROOT }, fileSystem, streams };
	function readLog(): string {
		return String(volume.readFileSync(runLogPath(ROOT), "utf8"));
	}

	return { options, readLog, streams };
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
		const options = { config: { formatters: ["agent"], rootDir: ROOT }, fileSystem, streams };

		await expect(
			withRunLogAsync(options, async () => {
				streams.stdout.write("summary\n");
				return 0;
			}),
		).resolves.toBe(0);

		expect(streams.stderr.received).toStrictEqual([]);
	});
});
