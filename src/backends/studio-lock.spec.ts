import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { clearStaleLock, watchLockRelease } from "./studio-lock.ts";

const PLACE_FILE = "C:/work/place.rbxl";
const LOCK_FILE = `${PLACE_FILE}.lock`;

function useFakeTimers(): void {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

describe(clearStaleLock, () => {
	it("should remove the place lock and name it", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem({ [LOCK_FILE]: "" });

		expect(clearStaleLock(fileSystem, PLACE_FILE)).toBe(LOCK_FILE);
		expect(volume.existsSync(LOCK_FILE)).toBeFalse();
	});

	it("should accept a place with no lock", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(clearStaleLock(fileSystem, PLACE_FILE)).toBe(LOCK_FILE);
	});
});

describe(watchLockRelease, () => {
	it("should terminate once the lock is released", () => {
		expect.assertions(2);

		useFakeTimers();
		const { fileSystem, volume } = createMemoryFileSystem({ [LOCK_FILE]: "" });
		const terminate = vi.fn<() => void>();
		watchLockRelease({ fileSystem, graceCapMs: 10_000, lockFile: LOCK_FILE, terminate });
		vi.advanceTimersByTime(200);

		expect(terminate).not.toHaveBeenCalled();

		volume.rmSync(LOCK_FILE);
		vi.advanceTimersByTime(1000);

		expect(terminate).toHaveBeenCalledOnce();
	});

	it("should terminate at the grace cap while the lock is still held", () => {
		expect.assertions(1);

		useFakeTimers();
		const { fileSystem } = createMemoryFileSystem({ [LOCK_FILE]: "" });
		const terminate = vi.fn<() => void>();
		watchLockRelease({ fileSystem, graceCapMs: 1000, lockFile: LOCK_FILE, terminate });
		vi.advanceTimersByTime(5000);

		expect(terminate).toHaveBeenCalledOnce();
	});
});
