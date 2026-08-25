import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CoverageUniverseFilter } from "./coverage-universe.ts";
import { createInstrumentUniverse, type InstrumentUniverse } from "./instrument-universe.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const CWD = normalizeWindowsPath(process.cwd());
/** A package sited away from the invocation directory. */
const PACKAGE_ROOT = normalizeWindowsPath(path.resolve("/repo/packages/foo"));

/** Empties the in-memory volume after the calling test, not right now. */
function resetVolumeAfterTest(): void {
	onTestFinished(() => {
		vol.reset();
	});
}

/** Absolute POSIX path for a cwd-relative one, as the walkers produce. */
function under(relativePath: string): string {
	return path.posix.join(CWD, relativePath);
}

/**
 * The universe for a filter that is known to narrow, so the tests can call
 * `includes` without re-deciding whether one exists.
 */
function universeFor(filter: CoverageUniverseFilter): InstrumentUniverse {
	const universe = createInstrumentUniverse(filter);
	assert(universe !== undefined, "expected the filter to narrow the universe");
	return universe;
}

function writeSourceMap(luauPath: string, contents: string): void {
	vol.mkdirSync(path.posix.dirname(luauPath), { recursive: true });
	vol.writeFileSync(luauPath, "return nil\n");
	vol.writeFileSync(`${luauPath}.map`, contents);
}

/** Write a compiled Luau file, optionally with its source-map sidecar. */
function writeCompiled(luauRelative: string, sources?: Array<string>): string {
	const luauPath = under(luauRelative);
	if (sources === undefined) {
		vol.mkdirSync(path.posix.dirname(luauPath), { recursive: true });
		vol.writeFileSync(luauPath, "return nil\n");
		return luauPath;
	}

	writeSourceMap(luauPath, JSON.stringify({ mappings: "", sources, version: 3 }));
	return luauPath;
}

describe(createInstrumentUniverse, () => {
	it("should return undefined when no include patterns narrow the universe", () => {
		expect.assertions(2);

		expect(createInstrumentUniverse({})).toBeUndefined();
		expect(createInstrumentUniverse({ include: [] })).toBeUndefined();
	});

	it("should return undefined when only ignore patterns are configured", () => {
		expect.assertions(1);

		// Ignore patterns alone cannot narrow instrumentation: they already
		// drop whole roots before this gate, and applying them per-file here
		// would only re-state that decision.
		expect(createInstrumentUniverse({ ignore: ["**/node_modules/**"] })).toBeUndefined();
	});

	it("should instrument a file whose source map points at an included source", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = writeCompiled("out/ecs/systems/move.luau", [
			under("src/ecs/systems/move.ts"),
		]);

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeTrue();
	});

	it("should skip a file whose source map points outside the universe", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = writeCompiled("out/ui/button.luau", [under("src/ui/button.ts")]);

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeFalse();
	});

	it("should honor a negated include pattern", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = writeCompiled("out/ecs/components/health.luau", [
			under("src/ecs/components/health.ts"),
		]);
		const universe = universeFor({
			include: ["src/ecs/**/*.ts", "!src/ecs/components/**"],
		});

		expect(universe.includes(luauPath)).toBeFalse();
	});

	it("should apply ignore patterns alongside the include globs", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = writeCompiled("out/ecs/index.luau", [under("src/ecs/index.ts")]);
		const universe = universeFor({ ignore: ["index.ts"], include: ["src/ecs/**/*.ts"] });

		expect(universe.includes(luauPath)).toBeFalse();
	});

	it("should resolve a relative source entry against the source map's directory", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = writeCompiled("out/ecs/systems/move.luau", [
			"../../../src/ecs/systems/move.ts",
		]);

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeTrue();
	});

	it("should keep a file when any of its sources is in the universe", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = writeCompiled("out/bundle.luau", [
			under("src/ui/button.ts"),
			under("src/ecs/systems/move.ts"),
		]);

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeTrue();
	});

	it("should match the Luau path itself when no source map exists", () => {
		expect.assertions(2);

		resetVolumeAfterTest();
		const covered = writeCompiled("src/ecs/systems/move.luau");
		const uncovered = writeCompiled("src/ui/button.luau");
		const universe = universeFor({ include: ["src/ecs/**/*.luau"] });

		// A hand-written Luau project has no source map, and the mapper keys
		// such a file on its own path — so the same path decides the gate.
		expect(universe.includes(covered)).toBeTrue();
		expect(universe.includes(uncovered)).toBeFalse();
	});

	it("should instrument a file whose source map cannot be read as JSON", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = under("out/ecs/systems/move.luau");
		writeSourceMap(luauPath, "{ not json");

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeTrue();
	});

	it("should instrument a file whose source map is not an object", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = under("out/ecs/systems/move.luau");
		writeSourceMap(luauPath, "[]");

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeTrue();
	});

	it("should instrument a file whose source map declares no usable sources", () => {
		expect.assertions(3);

		resetVolumeAfterTest();
		const missing = under("out/ecs/a.luau");
		const empty = under("out/ecs/b.luau");
		const nonString = under("out/ecs/c.luau");
		writeSourceMap(missing, JSON.stringify({ mappings: "", version: 3 }));
		writeSourceMap(empty, JSON.stringify({ mappings: "", sources: [], version: 3 }));
		writeSourceMap(nonString, JSON.stringify({ mappings: "", sources: [7], version: 3 }));
		const universe = universeFor({ include: ["src/ecs/**/*.ts"] });

		expect(universe.includes(missing)).toBeTrue();
		expect(universe.includes(empty)).toBeTrue();
		expect(universe.includes(nonString)).toBeTrue();
	});

	it("should instrument a file whose source map exists but cannot be read", () => {
		expect.assertions(1);

		resetVolumeAfterTest();
		const luauPath = under("out/ecs/systems/move.luau");
		vol.mkdirSync(path.posix.dirname(luauPath), { recursive: true });
		vol.writeFileSync(luauPath, "return nil\n");
		// A directory where the sidecar belongs stands in for any read that
		// fails for a reason other than absence. Unlike an absent sidecar, this
		// says nothing about the file's origin, so it must not be read as one.
		vol.mkdirSync(`${luauPath}.map`);

		expect(universeFor({ include: ["src/ecs/**/*.ts"] }).includes(luauPath)).toBeTrue();
	});

	it("should match include globs against the given rootDir", () => {
		expect.assertions(2);

		resetVolumeAfterTest();
		const luauPath = path.posix.join(PACKAGE_ROOT, "out/ecs/move.luau");
		writeSourceMap(
			luauPath,
			JSON.stringify({
				mappings: "",
				sources: [path.posix.join(PACKAGE_ROOT, "src/ecs/move.ts")],
				version: 3,
			}),
		);

		// The package's config writes `src/**/*.ts` for its own sources, and
		// the package sits nowhere near the invocation directory.
		expect(
			universeFor({ include: ["src/**/*.ts"], rootDir: PACKAGE_ROOT }).includes(luauPath),
		).toBeTrue();
		expect(universeFor({ include: ["src/**/*.ts"] }).includes(luauPath)).toBeFalse();
	});

	it("should digest the same universe however the globs are ordered", () => {
		expect.assertions(1);

		const forward = universeFor({ include: ["a/**/*.ts", "b/**/*.ts"] });
		const reversed = universeFor({ include: ["b/**/*.ts", "a/**/*.ts"] });

		expect(forward.digest).toBe(reversed.digest);
	});

	it("should digest the patterns that define the universe", () => {
		expect.assertions(2);

		const first = universeFor({ include: ["src/ecs/**/*.ts"] });
		const same = universeFor({ include: ["src/ecs/**/*.ts"] });
		const other = universeFor({ include: ["src/ui/**/*.ts"] });

		expect(first.digest).toBe(same.digest);
		expect(first.digest).not.toBe(other.digest);
	});

	it("should digest the ignore patterns too", () => {
		expect.assertions(1);

		const withIgnore = universeFor({ ignore: ["index.ts"], include: ["src/**/*.ts"] });
		const without = universeFor({ include: ["src/**/*.ts"] });

		expect(withIgnore.digest).not.toBe(without.digest);
	});

	it("should digest the rootDir the globs are anchored to", () => {
		expect.assertions(1);

		// Re-anchoring the same globs selects a different set of files, and
		// nothing else would invalidate the shadow copies left by the old one.
		const here = universeFor({ include: ["src/**/*.ts"], rootDir: PACKAGE_ROOT });
		const elsewhere = universeFor({ include: ["src/**/*.ts"], rootDir: `${PACKAGE_ROOT}-two` });

		expect(here.digest).not.toBe(elsewhere.digest);
	});
});
