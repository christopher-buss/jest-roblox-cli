import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import { prepareShadowRoot } from "./shadow-root.ts";

describe(prepareShadowRoot, () => {
	/**
	 * A volume seeded against the working directory, because this root is
	 * `.` and every path the walk builds resolves from there.
	 *
	 * @param files - What the run should find on disk.
	 */
	function seed(files: Record<string, string>): FileSystem {
		return createMemoryFileSystem(files).fileSystem;
	}

	// Both halves of the manifest key one file under one root, and the
	// incremental gate reads them back by that key. A root of `.` is the case
	// the two spellings disagree on — `path.join` drops the segment while a
	// pasted `${root}/` keeps it — and a key nothing else writes is a record
	// that never carries forward, so every warm run re-instruments the file.
	it("should key an instrumented file and a mirrored one alike under a current-directory root", () => {
		expect.assertions(2);

		const fileSystem = seed({ "init.luau": "local x = 1\n", "init.spec.luau": "return nil\n" });

		const result = prepareShadowRoot({
			fileSystem,
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("."),
			shadowDir: "/shadow",
			useIncremental: false,
		});

		expect(Object.keys(result.files)).toStrictEqual(["init.luau"]);
		expect(Object.keys(result.nonInstrumentedFiles)).toStrictEqual(["init.spec.luau"]);
	});
});
