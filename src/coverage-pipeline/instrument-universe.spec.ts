import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it } from "vitest";

import type { MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CoverageUniverseFilter } from "./coverage-universe.ts";
import { createInstrumentUniverse, type InstrumentUniverse } from "./instrument-universe.ts";

const CWD = normalizeWindowsPath(process.cwd());
/** A package sited away from the invocation directory. */
const PACKAGE_ROOT = normalizeWindowsPath(path.resolve("/repo/packages/foo"));

/** Absolute POSIX path for a cwd-relative one, as the walkers produce. */
function under(relativePath: string): string {
	return path.posix.join(CWD, relativePath);
}

/**
 * The universe for a filter that is known to narrow, so the tests can call
 * `includes` without re-deciding whether one exists.
 */
function universeFor(fileSystem: FileSystem, filter: CoverageUniverseFilter): InstrumentUniverse {
	const universe = createInstrumentUniverse(filter, fileSystem);
	assert(universe !== undefined, "expected the filter to narrow the universe");
	return universe;
}

function writeSourceMap(volume: MemoryVolume, luauPath: string, contents: string): void {
	volume.mkdirSync(path.posix.dirname(luauPath), { recursive: true });
	volume.writeFileSync(luauPath, "return nil\n");
	volume.writeFileSync(`${luauPath}.map`, contents);
}

/**
 * Write a compiled Luau file, optionally with its source-map sidecar.
 *
 * @param volume - Where the compiled file lands.
 * @param luauRelative - Its path, relative to the invocation directory.
 * @param sources - The sources its sidecar declares, when it has one.
 */
function writeCompiled(
	volume: MemoryVolume,
	luauRelative: string,
	sources?: Array<string>,
): string {
	const luauPath = under(luauRelative);
	if (sources === undefined) {
		volume.mkdirSync(path.posix.dirname(luauPath), { recursive: true });
		volume.writeFileSync(luauPath, "return nil\n");
		return luauPath;
	}

	writeSourceMap(volume, luauPath, JSON.stringify({ mappings: "", sources, version: 3 }));
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

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = writeCompiled(volume, "out/ecs/systems/move.luau", [
			under("src/ecs/systems/move.ts"),
		]);

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeTrue();
	});

	it("should skip a file whose source map points outside the universe", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = writeCompiled(volume, "out/ui/button.luau", [under("src/ui/button.ts")]);

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeFalse();
	});

	it("should honor a negated include pattern", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = writeCompiled(volume, "out/ecs/components/health.luau", [
			under("src/ecs/components/health.ts"),
		]);
		const universe = universeFor(fileSystem, {
			include: ["src/ecs/**/*.ts", "!src/ecs/components/**"],
		});

		expect(universe.includes(luauPath)).toBeFalse();
	});

	it("should apply ignore patterns alongside the include globs", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = writeCompiled(volume, "out/ecs/index.luau", [under("src/ecs/index.ts")]);
		const universe = universeFor(fileSystem, {
			ignore: ["index.ts"],
			include: ["src/ecs/**/*.ts"],
		});

		expect(universe.includes(luauPath)).toBeFalse();
	});

	it("should resolve a relative source entry against the source map's directory", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = writeCompiled(volume, "out/ecs/systems/move.luau", [
			"../../../src/ecs/systems/move.ts",
		]);

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeTrue();
	});

	it("should keep a file when any of its sources is in the universe", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = writeCompiled(volume, "out/bundle.luau", [
			under("src/ui/button.ts"),
			under("src/ecs/systems/move.ts"),
		]);

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeTrue();
	});

	it("should match the Luau path itself when no source map exists", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const covered = writeCompiled(volume, "src/ecs/systems/move.luau");
		const uncovered = writeCompiled(volume, "src/ui/button.luau");
		const universe = universeFor(fileSystem, { include: ["src/ecs/**/*.luau"] });

		// A hand-written Luau project has no source map, and the mapper keys
		// such a file on its own path — so the same path decides the gate.
		expect(universe.includes(covered)).toBeTrue();
		expect(universe.includes(uncovered)).toBeFalse();
	});

	it("should instrument a file whose source map cannot be read as JSON", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = under("out/ecs/systems/move.luau");
		writeSourceMap(volume, luauPath, "{ not json");

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeTrue();
	});

	it("should instrument a file whose source map is not an object", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = under("out/ecs/systems/move.luau");
		writeSourceMap(volume, luauPath, "[]");

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeTrue();
	});

	it("should instrument a file whose source map declares no usable sources", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const missing = under("out/ecs/a.luau");
		const empty = under("out/ecs/b.luau");
		const nonString = under("out/ecs/c.luau");
		writeSourceMap(volume, missing, JSON.stringify({ mappings: "", version: 3 }));
		writeSourceMap(volume, empty, JSON.stringify({ mappings: "", sources: [], version: 3 }));
		writeSourceMap(
			volume,
			nonString,
			JSON.stringify({ mappings: "", sources: [7], version: 3 }),
		);
		const universe = universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] });

		expect(universe.includes(missing)).toBeTrue();
		expect(universe.includes(empty)).toBeTrue();
		expect(universe.includes(nonString)).toBeTrue();
	});

	it("should instrument a file whose source map exists but cannot be read", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = under("out/ecs/systems/move.luau");
		volume.mkdirSync(path.posix.dirname(luauPath), { recursive: true });
		volume.writeFileSync(luauPath, "return nil\n");
		// A directory where the sidecar belongs stands in for any read that
		// fails for a reason other than absence. Unlike an absent sidecar, this
		// says nothing about the file's origin, so it must not be read as one.
		volume.mkdirSync(`${luauPath}.map`);

		expect(
			universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] }).includes(luauPath),
		).toBeTrue();
	});

	it("should match include globs against the given rootDir", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const luauPath = path.posix.join(PACKAGE_ROOT, "out/ecs/move.luau");
		writeSourceMap(
			volume,
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
			universeFor(fileSystem, { include: ["src/**/*.ts"], rootDir: PACKAGE_ROOT }).includes(
				luauPath,
			),
		).toBeTrue();
		expect(
			universeFor(fileSystem, { include: ["src/**/*.ts"] }).includes(luauPath),
		).toBeFalse();
	});

	it("should digest the same universe however the globs are ordered", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const forward = universeFor(fileSystem, { include: ["a/**/*.ts", "b/**/*.ts"] });
		const reversed = universeFor(fileSystem, { include: ["b/**/*.ts", "a/**/*.ts"] });

		expect(forward.digest).toBe(reversed.digest);
	});

	it("should digest the patterns that define the universe", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		const first = universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] });
		const same = universeFor(fileSystem, { include: ["src/ecs/**/*.ts"] });
		const other = universeFor(fileSystem, { include: ["src/ui/**/*.ts"] });

		expect(first.digest).toBe(same.digest);
		expect(first.digest).not.toBe(other.digest);
	});

	it("should digest the ignore patterns too", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const withIgnore = universeFor(fileSystem, {
			ignore: ["index.ts"],
			include: ["src/**/*.ts"],
		});
		const without = universeFor(fileSystem, { include: ["src/**/*.ts"] });

		expect(withIgnore.digest).not.toBe(without.digest);
	});

	it("should digest the rootDir the globs are anchored to", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		// Re-anchoring the same globs selects a different set of files, and
		// nothing else would invalidate the shadow copies left by the old one.
		const here = universeFor(fileSystem, { include: ["src/**/*.ts"], rootDir: PACKAGE_ROOT });
		const elsewhere = universeFor(fileSystem, {
			include: ["src/**/*.ts"],
			rootDir: `${PACKAGE_ROOT}-two`,
		});

		expect(here.digest).not.toBe(elsewhere.digest);
	});
});
