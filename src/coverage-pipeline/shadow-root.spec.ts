import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import { prepareShadowRoot } from "./shadow-root.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

describe(prepareShadowRoot, () => {
	function seed(files: Record<string, string>): void {
		onTestFinished(() => {
			vol.reset();
		});
		vol.fromJSON(files);
	}

	// Both halves of the manifest key one file under one root, and the
	// incremental gate reads them back by that key. A root of `.` is the case
	// the two spellings disagree on — `path.join` drops the segment while a
	// pasted `${root}/` keeps it — and a key nothing else writes is a record
	// that never carries forward, so every warm run re-instruments the file.
	it("should key an instrumented file and a mirrored one alike under a current-directory root", () => {
		expect.assertions(2);

		seed({ "init.luau": "local x = 1\n", "init.spec.luau": "return nil\n" });

		const result = prepareShadowRoot({
			isCopyIgnored: createCopyIgnoreMatcher([]),
			luauRoot: toPosixRoot("."),
			shadowDir: "/shadow",
			useIncremental: false,
		});

		expect(Object.keys(result.files)).toStrictEqual(["init.luau"]);
		expect(Object.keys(result.nonInstrumentedFiles)).toStrictEqual(["init.spec.luau"]);
	});
});
