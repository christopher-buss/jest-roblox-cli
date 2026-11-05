import istanbulCoverage from "istanbul-lib-coverage";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryReportEnvironment } from "#test/mocks/memory-report-context.ts";
import type { CoverageReporter } from "../config/schema.ts";
import { createReporter } from "./reporter-registry.ts";

const REPORTER_NAMES = {
	"clover": true,
	"cobertura": true,
	"html": true,
	"html-spa": true,
	"json": true,
	"json-summary": true,
	"lcov": true,
	"lcovonly": true,
	"none": true,
	"teamcity": true,
	"text": true,
	"text-lcov": true,
	"text-summary": true,
} satisfies Record<CoverageReporter, true>;

const ALL_REPORTERS = Object.keys(REPORTER_NAMES).filter((name): name is CoverageReporter => {
	return name in REPORTER_NAMES;
});

describe(createReporter, () => {
	it("should cover every reporter a config may name", () => {
		expect.assertions(1);

		expect(ALL_REPORTERS).toHaveLength(13);
	});

	// Construction is where the bundled build used to fail, and it fails per
	// reporter, so every name a config may carry is built here rather than only
	// the two the defaults reach.
	it.for(ALL_REPORTERS)("should construct the %s reporter", (name) => {
		expect.assertions(1);

		expect(createReporter(name, {})).toBeDefined();
	});
});

// Each html-writing reporter reaches its assets through a hook of its own, and
// a report run is what calls those hooks. "lcov" roots its html in a
// subdirectory; the other two write at the top.
describe("report execution", () => {
	it.for<[CoverageReporter, string]>([
		["html", "."],
		["html-spa", "."],
		["lcov", "lcov-report"],
	])("should write the %s report with its assets", ([name, subdirectory]) => {
		expect.assertions(1);

		const { createContext, directory, fileSystem } = createMemoryReportEnvironment();

		createReporter(name, {}).execute(
			createContext({ coverageMap: istanbulCoverage.createCoverageMap({}), dir: directory }),
		);

		expect(fileSystem.existsSync(path.join(directory, subdirectory, "base.css"))).toBeTrue();
	});
});
