import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { CoverageMap, ReadCoverageMapResult } from "./coverage-map.ts";
import { readCoverageMap, writeCoverageMap } from "./coverage-map.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

function exampleCoverageMap(overrides: Partial<CoverageMap> = {}): CoverageMap {
	return {
		statementMap: {
			"1": {
				end: { column: 12, line: 1 },
				start: { column: 1, line: 1 },
			},
		},
		...overrides,
	};
}

function expectOk(result: ReadCoverageMapResult): CoverageMap {
	if (result.kind !== "ok") {
		throw new Error(`expected ok, got ${result.kind}`);
	}

	return result.map;
}

describe(writeCoverageMap, () => {
	it("should round-trip statement-only map through readCoverageMap", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const map = exampleCoverageMap();
		writeCoverageMap("/coverage/out/init.cov-map.json", map);

		expect(expectOk(readCoverageMap("/coverage/out/init.cov-map.json"))).toStrictEqual(map);
	});

	it("should round-trip a map with functionMap and branchMap", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const map: CoverageMap = {
			branchMap: {
				"1": {
					locations: [
						{ end: { column: 6, line: 5 }, start: { column: 1, line: 4 } },
						{ end: { column: 6, line: 8 }, start: { column: 1, line: 7 } },
					],
					type: "if",
				},
			},
			functionMap: {
				"1": {
					name: "doThing",
					location: { end: { column: 4, line: 3 }, start: { column: 1, line: 2 } },
				},
			},
			statementMap: {
				"1": { end: { column: 12, line: 1 }, start: { column: 1, line: 1 } },
			},
		};

		writeCoverageMap("/coverage/out/x.cov-map.json", map);

		expect(expectOk(readCoverageMap("/coverage/out/x.cov-map.json"))).toStrictEqual(map);
	});

	it("should create parent directories before writing", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		writeCoverageMap("/deep/nested/out/x.cov-map.json", exampleCoverageMap());

		expect(vol.existsSync("/deep/nested/out/x.cov-map.json")).toBeTrue();
	});

	// This runs once per covered file into the shadow mirror the instrumenter
	// is filling, so it is the one publisher that declines `atomicWrite`'s
	// stray sweep — a directory scan per file is more than the write costs.
	it("should not scan the directory for strays", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/coverage/out/init.cov-map.json.tmp.4242.a1b2c3d4": "abandoned" });
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
		});
		const readSpy = vi.spyOn(fs, "readdirSync");

		writeCoverageMap("/coverage/out/init.cov-map.json", exampleCoverageMap());

		expect(readSpy).not.toHaveBeenCalled();
		expect(vol.existsSync("/coverage/out/init.cov-map.json.tmp.4242.a1b2c3d4")).toBeTrue();
	});
});

describe(readCoverageMap, () => {
	it("should return missing when file is absent", () => {
		expect.assertions(1);

		expect(readCoverageMap("/nonexistent.cov-map.json").kind).toBe("missing");
	});

	it("should return invalid when file contains malformed JSON", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/x.cov-map.json", "not json");

		expect(readCoverageMap("/coverage/x.cov-map.json").kind).toBe("invalid");
	});

	it("should return invalid when statementMap is missing", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync("/coverage/x.cov-map.json", "{}");

		expect(readCoverageMap("/coverage/x.cov-map.json").kind).toBe("invalid");
	});

	it("should return invalid when nested span shape is wrong", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync("/coverage", { recursive: true });
		vol.writeFileSync(
			"/coverage/x.cov-map.json",
			JSON.stringify({ statementMap: { "1": { end: "oops", start: "oops" } } }),
		);

		expect(readCoverageMap("/coverage/x.cov-map.json").kind).toBe("invalid");
	});

	it("should propagate non-ENOENT IO errors rather than misreport as missing", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// Reading a directory triggers EISDIR — a non-ENOENT IO error that
		// must not be folded into the missing/invalid cases.
		vol.mkdirSync("/coverage/dir.cov-map.json", { recursive: true });

		expect(() => readCoverageMap("/coverage/dir.cov-map.json")).toThrow(/EISDIR|illegal/i);
	});
});
