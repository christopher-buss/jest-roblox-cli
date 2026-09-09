import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import { MANIFEST_VERSION } from "./manifest.ts";
import type { CoverageManifest } from "./manifest.ts";
import { prepareShadowRoot, syncOneFile } from "./shadow-root.ts";

function manifestFrom(result: ReturnType<typeof prepareShadowRoot>): CoverageManifest {
	return {
		buildId: "previous",
		files: result.files,
		generatedAt: "2026-09-08T00:00:00.000Z",
		instrumenterVersion: 0,
		luauRoots: [result.luauRoot],
		nonInstrumentedFiles: result.nonInstrumentedFiles,
		shadowDir: result.shadowDir,
		version: MANIFEST_VERSION,
	};
}

describe(prepareShadowRoot, () => {
	it("should avoid an eager source scan when coverage is not narrowed", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/source/init.spec.luau": "return nil",
		});
		const readdir = vi.spyOn(fileSystem, "readdirSync");

		prepareShadowRoot({
			fileSystem,
			instrumenter: () => ({}),
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("/source"),
			shadowDir: "/shadow",
			useIncremental: false,
		});

		expect(readdir.mock.calls.filter(([directory]) => directory === "/source")).toHaveLength(1);
	});

	// Both halves of the manifest key one file under one root, and the
	// incremental gate reads them back by that key. A root of `.` is the case
	// the two spellings disagree on — `path.join` drops the segment while a
	// pasted `${root}/` keeps it — and a key nothing else writes is a record
	// that never carries forward, so every warm run re-instruments the file.
	it("should key an instrumented file and a mirrored one alike under a current-directory root", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem({
			"init.luau": "local x = 1\n",
			"init.spec.luau": "return nil\n",
		});

		const result = prepareShadowRoot({
			fileSystem,
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("."),
			shadowDir: "/shadow",
			useIncremental: false,
		});

		expect(Object.keys(result.files)).toStrictEqual(["init.luau"]);
		expect(Object.keys(result.nonInstrumentedFiles)).toStrictEqual(["init.spec.luau"]);
		expect(result.changed).toBeTrue();
	});

	it("should carry cached records forward when a new source appears without a universe", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem({
			"cached.luau": "local cached = true\n",
		});
		const options = {
			fileSystem,
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("."),
			shadowDir: "/shadow",
		};
		const first = prepareShadowRoot({ ...options, useIncremental: false });
		volume.writeFileSync("new.luau", "local added = true\n");

		const second = prepareShadowRoot({
			...options,
			previousManifest: manifestFrom(first),
			useIncremental: true,
		});

		expect(Object.keys(second.files).sort()).toStrictEqual(["cached.luau", "new.luau"]);
		expect(second.changed).toBeTrue();
	});

	it("should report an unchanged full-cache mirror as unchanged", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			"init.luau": "local x = 1\n",
			"init.spec.luau": "return nil\n",
		});
		const options = {
			fileSystem,
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("."),
			shadowDir: "/shadow",
		};
		const first = prepareShadowRoot({ ...options, useIncremental: false });

		const second = prepareShadowRoot({
			...options,
			previousManifest: manifestFrom(first),
			useIncremental: true,
		});

		expect(second.nonInstrumentedFiles["init.spec.luau"]).toBe(
			first.nonInstrumentedFiles["init.spec.luau"],
		);
		expect(second.changed).toBeFalse();
	});

	it("should report a deleted source when its shadow artifacts are already absent", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({ "init.luau": "local x = 1\n" });
		const options = {
			fileSystem,
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("."),
			shadowDir: "/shadow",
		};
		const first = prepareShadowRoot({ ...options, useIncremental: false });
		const record = first.files["init.luau"]!;
		volume.unlinkSync("init.luau");
		volume.unlinkSync(record.instrumentedLuauPath);
		volume.unlinkSync(record.coverageMapPath);

		const second = prepareShadowRoot({
			...options,
			previousManifest: manifestFrom(first),
			useIncremental: true,
		});

		expect(second.changed).toBeTrue();
	});
});

describe(syncOneFile, () => {
	it("should overwrite a stale target when a matching record names another path", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/source.luau": "return 'current'\n",
			"/target.luau": "return 'stale'\n",
		});
		const previousRecord = syncOneFile("/source.luau", "/previous.luau", undefined, fileSystem);

		const record = syncOneFile("/source.luau", "/target.luau", previousRecord, fileSystem);

		expect(record.shadowPath).toBe("/target.luau");
		expect(volume.readFileSync("/target.luau", "utf8")).toBe("return 'current'\n");
	});
});
