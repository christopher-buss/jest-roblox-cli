import { Buffer } from "node:buffer";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { atomicWrite } from "./atomic-write.ts";
import type { FileSystem } from "./file-system.ts";

/** A stray's stamp: an owner pid, and the nonce of the write that left it. */
const STRAY_STAMP = "4242.a1b2c3d4";

/**
 * Stands in for the rename primitive: throws the `EPERM` Windows raises while a
 * scanner holds the fresh temp file, for the first `failures` calls, then hands
 * off to the real one. `restoreMocks` puts the original back after each test.
 *
 * @param fileSystem - The volume whose rename primitive to stand in for.
 * @param failures - How many attempts to refuse before letting one through.
 */
function failRenameTimes(fileSystem: FileSystem, failures: number): void {
	const realRename = fileSystem.renameSync;
	let remaining = failures;
	vi.spyOn(fileSystem, "renameSync").mockImplementation((sourcePath, targetPath) => {
		remaining -= 1;
		if (remaining >= 0) {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		}

		realRename(sourcePath, targetPath);
	});
}

/**
 * Records the name of the temp file each write renames from, in call order, and
 * hands the rename itself to the real primitive. A temp file is gone by the
 * time the write returns, so the rename is the only place its name can be read.
 * `restoreMocks` puts the original back after each test.
 *
 * @param fileSystem - The volume whose rename primitive to stand in for.
 */
function captureTemporaryNames(fileSystem: FileSystem): Array<string> {
	const names: Array<string> = [];
	const realRename = fileSystem.renameSync;
	vi.spyOn(fileSystem, "renameSync").mockImplementation((sourcePath, targetPath) => {
		names.push(path.basename(String(sourcePath)));
		realRename(sourcePath, targetPath);
	});

	return names;
}

/**
 * Stands in for the delete primitive: refuses the temp file belonging to
 * `owner` with the `EPERM` Windows raises while a scanner holds one open, and
 * hands every other path to the real one. `restoreMocks` puts the original back
 * after each test.
 *
 * @param fileSystem - The volume whose delete primitive to stand in for.
 * @param owner - Whose temp file the platform will not let go of.
 */
function refuseToDeleteOwner(fileSystem: FileSystem, owner: number): void {
	const realRemove = fileSystem.rmSync;
	vi.spyOn(fileSystem, "rmSync").mockImplementation((targetPath, options) => {
		if (String(targetPath).includes(`.tmp.${owner}.`)) {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		}

		realRemove(targetPath, options);
	});
}

/**
 * Stands in for the liveness probe: every pid in `dead` answers `ESRCH` the way
 * `process.kill` does for a pid no longer running, and every other pid answers
 * as alive. `restoreMocks` puts the original back after each test.
 *
 * @param dead - Which owners the probe should report as gone.
 */
function reportDeadOwners(dead: ReadonlyArray<number>): void {
	vi.spyOn(process, "kill").mockImplementation((pid) => {
		if (dead.includes(pid)) {
			throw Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
		}

		return true;
	});
}

/**
 * Split a temp file's name into the target it publishes, its owner pid, and its
 * nonce.
 *
 * @param name - A temp file's basename, as the rename saw it.
 */
function splitStamp(name: string | undefined): [string, string, string] {
	const parts = (name ?? "").split(".tmp.");
	const [pid, nonce] = (parts[1] ?? "").split(".", 2);
	return [parts[0] ?? "", pid ?? "", nonce ?? ""];
}

describe(atomicWrite, () => {
	it("should write contents to the target path", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
	});

	it("should create missing parent directories before writing", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		atomicWrite({
			contents: "hello",
			fileSystem,
			targetPath: "/nested/deep/coverage/manifest.json",
		});

		expect(volume.existsSync("/nested/deep/coverage/manifest.json")).toBeTrue();
	});

	it("should accept Buffer contents", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		atomicWrite({
			contents: Buffer.from([0x00, 0x01, 0x02]),
			fileSystem,
			targetPath: "/coverage/place.rbxl",
		});

		expect(volume.readFileSync("/coverage/place.rbxl")).toStrictEqual(
			Buffer.from([0x00, 0x01, 0x02]),
		);
	});

	it("should land the write when the first rename attempts fail", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		failRenameTimes(fileSystem, 2);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
	});

	it("should replace an existing target on the last retry left", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "/coverage/manifest.json": "old" });
		failRenameTimes(fileSystem, 4);

		atomicWrite({ contents: "new", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("new");
	});

	it("should leave no file at the target path once the rename attempts are spent", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		failRenameTimes(fileSystem, 5);

		expect(() => {
			atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });
		}).toThrow("EPERM");
		expect(volume.existsSync("/coverage/manifest.json")).toBeFalse();
	});

	it("should normalize a non-Error rename failure", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		vi.spyOn(fileSystem, "renameSync").mockImplementation(() => {
			// eslint-disable-next-line ts/only-throw-error -- exercises the non-Error normalization branch
			throw "disk gone";
		});

		expect(() => {
			atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });
		}).toThrow("disk gone");
	});

	it("should pause between rename attempts but not before the first", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const waitSpy = vi.spyOn(Atomics, "wait");
		failRenameTimes(fileSystem, 2);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
		expect(waitSpy.mock.calls.map((call) => call[3])).toStrictEqual([2, 2]);
	});

	it("should name the temp file after this process and the write's own nonce", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem();

		const names = captureTemporaryNames(fileSystem);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		const [target, pid, nonce] = splitStamp(names[0]);

		expect(target).toBe("manifest.json");
		expect(pid).toBe(String(process.pid));
		expect(nonce).toHaveLength(8);
	});

	// Two live writers on one target would otherwise share a temp pathname —
	// and so would a writer handed a pid the operating system recycled from the
	// owner whose stray the sweep is on its way to delete.
	it("should give two writes to one target different temp names", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const names = captureTemporaryNames(fileSystem);

		atomicWrite({ contents: "first", fileSystem, targetPath: "/coverage/manifest.json" });
		atomicWrite({ contents: "second", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(names[0]).not.toBe(names[1]);
	});

	it("should delete a stray temp file left by a process that is no longer running", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.${STRAY_STAMP}`]: "abandoned" });
		reportDeadOwners([4242]);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.existsSync(`/coverage/manifest.json.tmp.${STRAY_STAMP}`)).toBeFalse();
		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
	});

	it("should keep the temp file of a peer that is still running", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.${STRAY_STAMP}`]: "in flight" });
		reportDeadOwners([]);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync(`/coverage/manifest.json.tmp.${STRAY_STAMP}`, "utf-8")).toBe(
			"in flight",
		);
	});

	it("should read no directory at all when the caller opts out of the sweep", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.${STRAY_STAMP}`]: "abandoned" });
		reportDeadOwners([4242]);
		const readSpy = vi.spyOn(fileSystem, "readdirSync");

		atomicWrite({
			contents: "hello",
			fileSystem,
			sweepStrays: false,
			targetPath: "/coverage/manifest.json",
		});

		expect(readSpy).not.toHaveBeenCalled();
		expect(volume.readFileSync(`/coverage/manifest.json.tmp.${STRAY_STAMP}`, "utf-8")).toBe(
			"abandoned",
		);
	});

	it("should keep a temp file whose owner refuses the liveness probe", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.${STRAY_STAMP}`]: "another user write" });
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		});

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync(`/coverage/manifest.json.tmp.${STRAY_STAMP}`, "utf-8")).toBe(
			"another user write",
		);
	});

	// The sibling's name is the same length as the target's on purpose: the
	// stamp is read at a fixed offset, so an equal-length name is exactly the
	// one a sweep that skipped the prefix check would read a valid stamp out of
	// and delete.
	it("should leave a sibling target's stray temp file alone", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/place.json.tmp.${STRAY_STAMP}`]: "another target" });
		reportDeadOwners([4242]);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/cache.json" });

		expect(volume.readFileSync(`/coverage/place.json.tmp.${STRAY_STAMP}`, "utf-8")).toBe(
			"another target",
		);
	});

	it("should leave a sibling alone when more follows the nonce", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.${STRAY_STAMP}.bak`]: "not a temp file" });
		reportDeadOwners([4242]);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync(`/coverage/manifest.json.tmp.${STRAY_STAMP}.bak`, "utf-8")).toBe(
			"not a temp file",
		);
	});

	it("should leave a sibling alone when the stamp opens with more than a pid", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.pid${STRAY_STAMP}`]: "not a temp file" });
		reportDeadOwners([4242]);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync(`/coverage/manifest.json.tmp.pid${STRAY_STAMP}`, "utf-8")).toBe(
			"not a temp file",
		);
	});

	// Only a writer from before the nonce existed leaves one, and that is the
	// writer a recycled pid can put back behind this very name while the sweep
	// runs. Whoever the pid names now, the file stays.
	it("should leave a temp file carrying no nonce alone", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "/coverage/manifest.json.tmp.4242": "left by an older version" });
		reportDeadOwners([4242]);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json.tmp.4242", "utf-8")).toBe(
			"left by an older version",
		);
	});

	it("should publish even when a stray temp file cannot be deleted", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ [`/coverage/manifest.json.tmp.${STRAY_STAMP}`]: "abandoned" });
		reportDeadOwners([4242]);
		vi.spyOn(fileSystem, "rmSync").mockImplementation(() => {
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		});

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("hello");
	});

	it("should keep sweeping past a stray temp file it cannot delete", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({
			"/coverage/manifest.json.tmp.4242.a1b2c3d4": "held open",
			"/coverage/manifest.json.tmp.4243.a1b2c3d4": "abandoned",
		});
		reportDeadOwners([4242, 4243]);
		refuseToDeleteOwner(fileSystem, 4242);

		atomicWrite({ contents: "hello", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.existsSync("/coverage/manifest.json.tmp.4243.a1b2c3d4")).toBeFalse();
	});

	it("should publish when the directory cannot be listed at all", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "/coverage/manifest.json": "old" });
		vi.spyOn(fileSystem, "readdirSync").mockImplementation(() => {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		});

		atomicWrite({ contents: "new", fileSystem, targetPath: "/coverage/manifest.json" });

		expect(volume.readFileSync("/coverage/manifest.json", "utf-8")).toBe("new");
	});
});
