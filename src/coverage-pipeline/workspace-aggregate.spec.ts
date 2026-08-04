import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { CoverageManifest } from "./manifest.ts";
import { MANIFEST_VERSION } from "./manifest.ts";
import type { MappedFileCoverage } from "./mapper.ts";
import type { RawCoverageData } from "./types.ts";
import { aggregateWorkspaceCoverage } from "./workspace-aggregate.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});
vi.mock(import("./mapper.ts"));

function fileStub(tsPath: string): MappedFileCoverage {
	return {
		b: {},
		branchMap: {},
		f: {},
		fnMap: {},
		path: tsPath,
		s: { "0": 0 },
		statementMap: { "0": { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } } },
	};
}

function manifestStub(): CoverageManifest {
	return {
		buildId: "test-build-id",
		files: {},
		generatedAt: "2026-05-10T00:00:00.000Z",
		instrumenterVersion: 2,
		luauRoots: [],
		nonInstrumentedFiles: {},
		shadowDir: "/shadow",
		version: MANIFEST_VERSION,
	};
}

describe(aggregateWorkspaceCoverage, () => {
	it("should call mapCoverageToTypeScript once per package with that package's manifest", async () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		const fooManifest = manifestStub();
		const barManifest = manifestStub();
		const fooCoverage: RawCoverageData = { "foo.luau": { s: { "1": 3 } } };
		const barCoverage: RawCoverageData = { "bar.luau": { s: { "1": 5 } } };

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);
		mapped.mockReturnValue({ files: {} });

		aggregateWorkspaceCoverage([
			{ coverageData: fooCoverage, manifest: fooManifest, pkg: "@halcyon/foo" },
			{ coverageData: barCoverage, manifest: barManifest, pkg: "@halcyon/bar" },
		]);

		expect(mapped).toHaveBeenCalledTimes(2);
		expect(mapped).toHaveBeenNthCalledWith(1, fooCoverage, fooManifest);
		expect(mapped).toHaveBeenNthCalledWith(2, barCoverage, barManifest);
	});

	it("should keep each package's mapped files on its own universe", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);

		mapped.mockImplementation((coverage) => {
			const tsKey = Object.keys(coverage)[0]!.replace(/\.luau$/, ".ts");
			return {
				files: {
					[tsKey]: {
						b: {},
						branchMap: {},
						f: {},
						fnMap: {},
						path: tsKey,
						s: { "0": 1 },
						statementMap: {
							"0": {
								end: { column: 10, line: 1 },
								start: { column: 0, line: 1 },
							},
						},
					},
				},
			};
		});

		const result = aggregateWorkspaceCoverage([
			{
				coverageData: { "foo.luau": { s: { "1": 1 } } },
				manifest: manifestStub(),
				pkg: "@halcyon/foo",
			},
			{
				coverageData: { "bar.luau": { s: { "1": 1 } } },
				manifest: manifestStub(),
				pkg: "@halcyon/bar",
			},
		]);

		expect(result.map((entry) => Object.keys(entry.universe.files))).toStrictEqual([
			["foo.ts"],
			["bar.ts"],
		]);
		expect(result[0]!.universe.files["foo.ts"]!.s).toStrictEqual({ "0": 1 });
	});

	it("should skip packages whose coverageData is undefined", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);
		mapped.mockReturnValue({ files: {} });

		aggregateWorkspaceCoverage([
			{ coverageData: undefined, manifest: manifestStub(), pkg: "@halcyon/foo" },
		]);

		expect(mapped).not.toHaveBeenCalled();
	});

	it("should be a no-op when given no packages", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		expect(aggregateWorkspaceCoverage([])).toStrictEqual([]);
	});

	it("should drop files matching that package's own ignore patterns only", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);
		mapped.mockImplementation((coverage) => {
			const stem = Object.keys(coverage)[0]!.replace(/\.luau$/, "");
			const tsPath = `${stem}/index.ts`;
			return {
				files: {
					[tsPath]: {
						b: {},
						branchMap: {},
						f: {},
						fnMap: {},
						path: tsPath,
						s: { "0": 0 },
						statementMap: {
							"0": { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } },
						},
					},
				},
			};
		});

		// foo ignores index barrels; bar does not. The pattern must scope to foo
		// only — a package that opts out keeps its own index.ts.
		const result = aggregateWorkspaceCoverage([
			{
				coverageData: { "foo.luau": { s: {} } },
				ignorePatterns: ["**/index.ts"],
				manifest: manifestStub(),
				pkg: "@halcyon/foo",
			},
			{
				coverageData: { "bar.luau": { s: {} } },
				ignorePatterns: [],
				manifest: manifestStub(),
				pkg: "@halcyon/bar",
			},
		]);

		expect(result.map((entry) => Object.keys(entry.universe.files))).toStrictEqual([
			[],
			["bar/index.ts"],
		]);
	});

	it("should narrow a package to its own collectCoverageFrom globs", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);
		mapped.mockReturnValue({
			files: {
				"src/keep.ts": fileStub("src/keep.ts"),
				"tools/drop.ts": fileStub("tools/drop.ts"),
			},
		});

		// The include globs belong to the package, so a package that narrows its
		// own universe cannot narrow another's — and the report and the gate see
		// the same files.
		const result = aggregateWorkspaceCoverage([
			{
				coverageData: { "foo.luau": { s: {} } },
				includePatterns: ["src/**/*.ts"],
				manifest: manifestStub(),
				pkg: "@halcyon/foo",
			},
		]);

		expect(Object.keys(result[0]!.universe.files)).toStrictEqual(["src/keep.ts"]);
	});

	it("should skip a package with no coverageData when listing universes", async () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);
		mapped.mockImplementation((coverage) => {
			const stem = Object.keys(coverage)[0]!.replace(/\.luau$/, "");
			const tsPath = `${stem}/index.ts`;
			return {
				files: {
					[tsPath]: {
						b: {},
						branchMap: {},
						f: {},
						fnMap: {},
						path: tsPath,
						s: { "0": 0 },
						statementMap: {
							"0": { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } },
						},
					},
				},
			};
		});

		// A package with no coverageData contributes no universe entry — same
		// skip rule the merge applies.
		const result = aggregateWorkspaceCoverage([
			{
				coverageData: { "foo.luau": { s: {} } },
				ignorePatterns: ["**/index.ts"],
				manifest: manifestStub(),
				pkg: "@halcyon/foo",
			},
			{
				coverageData: { "bar.luau": { s: {} } },
				manifest: manifestStub(),
				pkg: "@halcyon/bar",
			},
			{ coverageData: undefined, manifest: manifestStub(), pkg: "@halcyon/baz" },
		]);

		expect(result.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		expect(result[0]!.universe.files).toStrictEqual({});
		expect(Object.keys(result[1]!.universe.files)).toStrictEqual(["bar/index.ts"]);
	});

	it("should keep mapper outputs disjoint when packages map to the same TS file", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const { mapCoverageToTypeScript } = await import("./mapper.ts");
		const mapped = vi.mocked(mapCoverageToTypeScript);

		// Both packages map to "shared.ts" from different sources. Keeping the
		// universes per package is what makes that unambiguous: neither entry can
		// overwrite the other.
		mapped.mockReturnValueOnce({
			files: {
				"shared.ts": {
					b: {},
					branchMap: {},
					f: {},
					fnMap: {},
					path: "shared.ts",
					s: { "0": 7 },
					statementMap: {
						"0": { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } },
					},
				},
			},
		});
		mapped.mockReturnValueOnce({
			files: {
				"shared.ts": {
					b: {},
					branchMap: {},
					f: {},
					fnMap: {},
					path: "shared.ts",
					s: { "0": 4 },
					statementMap: {
						"0": { end: { column: 1, line: 1 }, start: { column: 0, line: 1 } },
					},
				},
			},
		});

		const result = aggregateWorkspaceCoverage([
			{
				coverageData: { "a.luau": { s: { "1": 1 } } },
				manifest: manifestStub(),
				pkg: "@halcyon/foo",
			},
			{
				coverageData: { "b.luau": { s: { "1": 1 } } },
				manifest: manifestStub(),
				pkg: "@halcyon/bar",
			},
		]);

		expect(result[0]!.universe.files["shared.ts"]!.s).toStrictEqual({ "0": 7 });
		expect(result[1]!.universe.files["shared.ts"]!.s).toStrictEqual({ "0": 4 });
	});
});
