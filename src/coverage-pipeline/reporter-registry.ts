/// <reference path="./istanbul-modules.d.ts" />
import type { ReportBase } from "istanbul-lib-report";
import CloverReport from "istanbul-reports/lib/clover/index.js";
import CoberturaReport from "istanbul-reports/lib/cobertura/index.js";
import HtmlSpaReport from "istanbul-reports/lib/html-spa/index.js";
import HtmlReport from "istanbul-reports/lib/html/index.js";
import JsonSummaryReport from "istanbul-reports/lib/json-summary/index.js";
import JsonReport from "istanbul-reports/lib/json/index.js";
import LcovReport from "istanbul-reports/lib/lcov/index.js";
import LcovOnlyReport from "istanbul-reports/lib/lcovonly/index.js";
import NoneReport from "istanbul-reports/lib/none/index.js";
import TeamcityReport from "istanbul-reports/lib/teamcity/index.js";
import TextLcovReport from "istanbul-reports/lib/text-lcov/index.js";
import TextSummaryReport from "istanbul-reports/lib/text-summary/index.js";
import TextReport from "istanbul-reports/lib/text/index.js";

import type { CoverageReporter } from "../config/schema.ts";
import type { HtmlAssetGroup } from "./html-assets.ts";
import { writeIstanbulHtmlAssets } from "./html-assets.ts";

/**
 * Every reporter, named the way `coverageReporters` names it, bound to its
 * class rather than to its module path.
 *
 * `istanbulReports.create(name)` — the documented way to do this — resolves the
 * class with `require(path.join(__dirname, 'lib', name))`. A bundler cannot see
 * through that: no reporter module is reachable from the entry, so none is
 * bundled, and the standalone binary (which resolves built-in modules and
 * nothing else) failed every `--coverage` run with
 * `No such built-in module: <exe dir>/lib/text`. Naming each class in an import
 * is what puts it in the bundle.
 *
 * The three html-writing reporters are built through factories of their own,
 * because bundling a reporter class does not bundle the asset files it copies.
 */
const REPORTER_FACTORIES = {
	"clover": (options: object) => new CloverReport(options),
	"cobertura": (options: object) => new CoberturaReport(options),
	"html": (options: object) => carryAssets(new HtmlReport(options), "html"),
	"html-spa": (options: object) => createHtmlSpaReport(options),
	"json": (options: object) => new JsonReport(options),
	"json-summary": (options: object) => new JsonSummaryReport(options),
	"lcov": (options: object) => createLcovReport(options),
	"lcovonly": (options: object) => new LcovOnlyReport(options),
	"none": (options: object) => new NoneReport(options),
	"teamcity": (options: object) => new TeamcityReport(options),
	"text": (options: object) => new TextReport(options),
	"text-lcov": (options: object) => new TextLcovReport(options),
	"text-summary": (options: object) => new TextSummaryReport(options),
} as const satisfies Record<CoverageReporter, (options: object) => ReportBase>;

export function createReporter(name: CoverageReporter, options: object): ReportBase {
	return REPORTER_FACTORIES[name](options);
}

/**
 * Istanbul's html reporter copies its assets from `__dirname/assets` in
 * `onStart`, which is the one thing left in a bundled reporter that still
 * reaches for a file beside its module. Nothing lets that directory be
 * configured, so the hook is replaced on the instance: same phase, same writer,
 * assets from the bundle.
 */
function carryAssets(report: HtmlReport, group: HtmlAssetGroup): HtmlReport {
	report.onStart = (_root, context) => {
		writeIstanbulHtmlAssets(report.getWriter(context), group);
	};

	return report;
}

/**
 * `html-spa` writes two sets of assets: the html reporter's, through the
 * instance it delegates to, and its own on top. Its `onStart` reads that second
 * set off disk itself, so both halves are replaced.
 */
function createHtmlSpaReport(options: object): HtmlSpaReport {
	const report = new HtmlSpaReport(options);
	carryAssets(report.htmlReport, "html");

	report.onStart = (root, context) => {
		report.htmlReport.onStart(root, context);
		writeIstanbulHtmlAssets(report.getWriter(context), "html-spa");
	};

	return report;
}

/** Half of `lcov` is an html report, rooted at `lcov-report/`. */
function createLcovReport(options: object): LcovReport {
	const report = new LcovReport(options);
	carryAssets(report.html, "html");
	return report;
}
