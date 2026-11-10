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

import type { CoverageReporter } from "../config/config-types.ts";
import type { HtmlAssetGroup } from "./html-assets.ts";
import { writeIstanbulHtmlAssets } from "./html-assets.ts";

// Static imports, not `istanbulReports.create(name)`: its dynamic require
// escapes the bundle.
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

/**
 * Create an Istanbul report whose assets come from the bundle.
 * @param name - Reporter to create.
 * @param options - Istanbul reporter options.
 * @returns The report instance.
 */
export function createReporter(name: CoverageReporter, options: object): ReportBase {
	return REPORTER_FACTORIES[name](options);
}

function carryAssets(report: HtmlReport, group: HtmlAssetGroup): HtmlReport {
	report.onStart = (_root, context) => {
		writeIstanbulHtmlAssets(report.getWriter(context), group);
	};

	return report;
}

function createHtmlSpaReport(options: object): HtmlSpaReport {
	const report = new HtmlSpaReport(options);
	carryAssets(report.htmlReport, "html");

	report.onStart = (root, context) => {
		report.htmlReport.onStart(root, context);
		writeIstanbulHtmlAssets(report.getWriter(context), "html-spa");
	};

	return report;
}

function createLcovReport(options: object): LcovReport {
	const report = new LcovReport(options);
	carryAssets(report.html, "html");
	return report;
}
