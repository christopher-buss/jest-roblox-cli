// Upstream ships no types for reporter modules; see `reporter-registry.ts`.
declare module "istanbul-reports/lib/*" {
	import type { ReportBase } from "istanbul-lib-report";

	const Report: new (options?: object) => ReportBase;
	export default Report;
}

// Declared after the wildcard so these named members win.
declare module "istanbul-reports/lib/html/index.js" {
	import type { Context, FileWriter, Node, ReportBase } from "istanbul-lib-report";

	interface HtmlReport extends ReportBase {
		getWriter(context: Context): FileWriter;
		onStart(root: Node, context: Context): void;
	}

	const HtmlReport: new (options?: object) => HtmlReport;
	export default HtmlReport;
}

declare module "istanbul-reports/lib/html-spa/index.js" {
	import type { Context, FileWriter, Node, ReportBase } from "istanbul-lib-report";
	import type HtmlReport from "istanbul-reports/lib/html/index.js";

	interface HtmlSpaReport extends ReportBase {
		getWriter(context: Context): FileWriter;
		htmlReport: HtmlReport;
		onStart(root: Node, context: Context): void;
	}

	const HtmlSpaReport: new (options?: object) => HtmlSpaReport;
	export default HtmlSpaReport;
}

declare module "istanbul-reports/lib/lcov/index.js" {
	import type { ReportBase } from "istanbul-lib-report";
	import type HtmlReport from "istanbul-reports/lib/html/index.js";

	interface LcovReport extends ReportBase {
		html: HtmlReport;
	}

	const LcovReport: new (options?: object) => LcovReport;
	export default LcovReport;
}

// Built by `loaders/istanbul-html-assets.mjs`; shapes must match.
declare module "virtual:istanbul-html-assets" {
	type IstanbulHtmlAsset = { base64: string; name: string } | { name: string; text: string };

	const istanbulHtmlAssets: {
		"html": Array<IstanbulHtmlAsset>;
		"html-spa": Array<IstanbulHtmlAsset>;
	};
	export default istanbulHtmlAssets;
}
