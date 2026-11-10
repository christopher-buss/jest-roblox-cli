import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { CoverageMapper } from "../coverage-report/mapper.ts";
import { toCoverageUnit } from "./coverage-unit.ts";

type CoverageUnitSettings = Parameters<typeof toCoverageUnit>[0]["settings"];

const MANIFEST = fromAny<CoverageManifest, unknown>({});

const SETTINGS: CoverageUnitSettings = {
	coverageDirectory: "/pkg/coverage",
	coverageReporters: ["text"],
	rootDir: "/pkg",
};

function mapperOver(paths: Array<string>) {
	return vi.fn<CoverageMapper>(() => {
		return fromPartial({ files: Object.fromEntries(paths.map((key) => [key, { path: key }])) });
	});
}

describe(toCoverageUnit, () => {
	it("should give a notice and no unit when no coverage data came back", () => {
		expect.assertions(1);

		expect(
			toCoverageUnit({
				coverageData: undefined,
				manifest: MANIFEST,
				mapCoverage: mapperOver([]),
				settings: SETTINGS,
			}),
		).toStrictEqual({
			notice: "Warning: coverage data was empty — the Rojo project may point at uninstrumented source",
			units: [],
		});
	});

	it("should name the unit's label in a missing-manifest notice", () => {
		expect.assertions(1);

		expect(
			toCoverageUnit({
				coverageData: fromAny({}),
				label: "@scope/pkg",
				manifest: undefined,
				mapCoverage: mapperOver([]),
				settings: SETTINGS,
			}),
		).toStrictEqual({
			notice: "Warning: Coverage manifest not found, skipping TS mapping (@scope/pkg)",
			units: [],
		});
	});

	it("should match include globs against rootDir, not the working directory", () => {
		expect.assertions(1);

		const coverage = toCoverageUnit({
			coverageData: fromAny({}),
			manifest: MANIFEST,
			mapCoverage: mapperOver(["/pkg/src/a.ts", "/pkg/src/a.spec.ts", "/other/src/b.ts"]),
			settings: {
				...SETTINGS,
				collectCoverageFrom: ["src/**/*.ts", "!**/*.spec.ts"],
			},
		});

		expect(Object.keys(coverage.units[0]!.universe.files)).toStrictEqual(["/pkg/src/a.ts"]);
	});

	it("should drop files matching an ignore pattern", () => {
		expect.assertions(1);

		const coverage = toCoverageUnit({
			coverageData: fromAny({}),
			manifest: MANIFEST,
			mapCoverage: mapperOver(["/pkg/src/a.ts", "/pkg/gen/b.ts"]),
			settings: { ...SETTINGS, coveragePathIgnorePatterns: ["gen/**"] },
		});

		expect(Object.keys(coverage.units[0]!.universe.files)).toStrictEqual(["/pkg/src/a.ts"]);
	});

	it("should carry the unit's report and gate settings", () => {
		expect.assertions(1);

		const coverage = toCoverageUnit({
			coverageData: fromAny({}),
			label: "pkg",
			manifest: MANIFEST,
			mapCoverage: mapperOver([]),
			settings: { ...SETTINGS, coverageThreshold: { lines: 80 } },
		});

		expect(coverage).toStrictEqual({
			units: [
				{
					coverageDirectory: "/pkg/coverage",
					coverageThreshold: { lines: 80 },
					label: "pkg",
					reporters: ["text"],
					universe: { files: {} },
				},
			],
		});
	});
});

describe("partial runs", () => {
	it("should scope reports and thresholds to changed files within the configured universe", () => {
		expect.assertions(1);

		const result = toCoverageUnit({
			changedFiles: ["/pkg/src/a.ts", "/pkg/src/a.spec.ts", "/pkg/deleted.ts"],
			coverageData: fromAny({}),
			manifest: MANIFEST,
			mapCoverage: mapperOver(["/pkg/src/a.ts", "/pkg/src/b.ts", "/pkg/src/a.spec.ts"]),
			settings: { ...SETTINGS, collectCoverageFrom: ["src/**/*.ts", "!**/*.spec.ts"] },
		});

		expect(Object.keys(result.units[0]!.universe.files)).toStrictEqual(["/pkg/src/a.ts"]);
	});
});
